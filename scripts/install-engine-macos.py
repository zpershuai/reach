#!/usr/bin/env python3
"""Stage a private macOS installation and restore launchd/files on failure."""
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from binary_identity import check_executable, host_platform
from install_transaction import stage_file, restore_file


def select_label(home, wrapper):
    existing = set()
    for path in (home / 'Library/LaunchAgents').glob('*.plist'):
        try:
            document = plistlib.loads(path.read_bytes())
        except (OSError, plistlib.InvalidFileException, ValueError):
            continue
        if document.get('ProgramArguments') == [str(wrapper)]:
            existing.add(document['Label'])
    label = os.environ.get('REACH_LAUNCHD_LABEL') or next(iter(existing), 'org.reach.engine')
    if len(existing) > 1 or existing and label not in existing:
        raise ValueError('Resolve duplicate LaunchAgents or reuse the existing label')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', label):
        raise ValueError('Invalid launchd label')
    return label


def install_engine(repo, home, source, config, devices=None, *, runner=subprocess.run,
                   checkpoint=lambda step: None, target=None, uid=None):
    target = target or host_platform()
    if not target.startswith('darwin-'):
        raise ValueError('macOS installer requires Darwin')
    engine_dir, config_dir, reach = home / '.local/share/reach', home / '.config/reach', home / '.reach'
    label = select_label(home, engine_dir / 'start-engine.sh')
    domain = f'gui/{os.getuid() if uid is None else uid}'
    service = domain + '/' + label
    agent = home / 'Library/LaunchAgents' / (label + '.plist')
    for path in [source, config, repo / 'scripts/run-node.sh', repo / 'scripts/install-node-runtime.py', repo / 'scripts/engine-supervisor.mjs']:
        if not path.is_file(): raise ValueError('Missing installer input')
    check_executable(source.read_bytes(), target)
    checkpoint('source-identity')

    def run(arguments, check=True):
        return runner(arguments, check=check, text=True, capture_output=True)

    version = run([str(source), '--version']).stdout.strip()
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Invalid Engine version')
    run(['/bin/bash', '-n', str(config)])
    for directory in [engine_dir, config_dir, reach, reach / 'workspace', agent.parent, reach / 'runtime']:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (reach / '.engine-install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        loaded = run(['launchctl', 'print', service], check=False).returncode == 0
        disabled_output = run(['launchctl', 'print-disabled', domain]).stdout
        disabled = bool(re.search(r'"' + re.escape(label) + r'"\s*=>\s*true', disabled_output))
        backup = reach / 'backups' / ('macos-' + uuid.uuid4().hex)
        backup.mkdir(mode=0o700, parents=True)
        saved, staged, committed = {}, {}, []
        new_runtime = None
        touched = False

        def stage(path, **values):
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            snapshot = backup / str(len(saved))
            saved[path] = None
            if os.path.lexists(path):
                shutil.copy2(path, snapshot, follow_symlinks=False); saved[path] = snapshot
            staged[path] = stage_file(path, **values)
            checkpoint('stage:' + path.name)

        try:
            with tempfile.TemporaryDirectory(prefix='.engine-install-', dir=reach) as temporary:
                node = Path(run([sys.executable, str(repo / 'scripts/install-node-runtime.py'), '--root', temporary]).stdout.strip()).resolve(strict=True)
                distribution = node.parent.parent
                if distribution.parent != Path(temporary).resolve() / 'runtime': raise ValueError('Runtime escaped staging')
                node_version = run([str(node), '--version']).stdout.strip()
                new_runtime = reach / 'runtime' / distribution.name
                if os.path.lexists(new_runtime): raise ValueError('Runtime release already exists')
                os.replace(distribution, new_runtime)
            checkpoint('runtime')
            stage(engine_dir / 'engine', source=source, mode=0o755)
            stage(config_dir / 'engine.env', source=config)
            stage(engine_dir / 'run-node.sh', source=repo / 'scripts/run-node.sh', mode=0o755)
            stage(engine_dir / 'engine-supervisor.mjs', source=repo / 'scripts/engine-supervisor.mjs', mode=0o644)
            stage(reach / 'runtime/node', link=new_runtime.name)
            stage(engine_dir / 'start-engine.sh', content='#!/bin/bash\nset -euo pipefail\nset -a\nsource "$HOME/.config/reach/engine.env"\nset +a\nexec "$HOME/.local/share/reach/run-node.sh" "$HOME/.local/share/reach/engine-supervisor.mjs" "$HOME/.local/share/reach/engine"\n', mode=0o700)
            plist = {'Label': label, 'ProgramArguments': [str(engine_dir / 'start-engine.sh')], 'RunAtLoad': True,
                     'KeepAlive': True, 'ThrottleInterval': 10, 'StandardOutPath': str(engine_dir / 'engine.log'), 'StandardErrorPath': str(engine_dir / 'engine-error.log')}
            stage(agent, content=plistlib.dumps(plist).decode(), mode=0o644)
            mcp_version = None
            if devices:
                json.loads(devices.read_text())
                stage(config_dir / 'mcp-devices.json', source=devices)
                package = repo / 'packages/grok-bot-mcp-connector'
                stage(engine_dir / 'mcp/package.json', source=package / 'package.json', mode=0o644)
                for name in ['main.js', 'config.js', 'gateway.js', 'server.js', 'tools.js', 'protocol.js', 'invoker.js', 'result.js', 'version.js', 'version.json']:
                    stage(engine_dir / 'mcp/dist' / name, source=package / 'dist' / name, mode=0o644)
                mcp_version = json.loads((package / 'dist/version.json').read_text())['version']
            if devices or (engine_dir / 'mcp/dist/main.js').exists() and (config_dir / 'mcp-devices.json').exists():
                path = config_dir / 'mcp.json'
                document = json.loads(path.read_text()) if path.exists() else {}
                server = document.setdefault('mcpServers', {}).setdefault('reach', {})
                server.update(command=str(reach / 'runtime/node/bin/node'), args=[str(engine_dir / 'mcp/dist/main.js')])
                environment = server.setdefault('env', {})
                environment['REACH_MCP_DEVICES_FILE'] = str(config_dir / 'mcp-devices.json')
                environment.pop('REACH_NODE_BIN', None); environment.setdefault('REACH_MCP_READY_POLL_MS', '1000')
                stage(path, content=json.dumps(document, indent=2) + '\n')
            inventory = reach / 'versions.json'
            versions = json.loads(inventory.read_text()) if inventory.exists() else {}
            versions.update(engineVersion=version, nodeVersion=node_version)
            if mcp_version is not None or 'mcpVersion' not in versions: versions['mcpVersion'] = mcp_version
            stage(inventory, content=json.dumps(versions, indent=2) + '\n')
            recovery = {'schemaVersion': 1, 'service': service, 'loaded': loaded, 'disabled': disabled,
                        'files': [{'target': str(path), 'backup': str(snapshot) if snapshot else None} for path, snapshot in saved.items()]}
            (backup / 'recovery.json').write_text(json.dumps(recovery, indent=2) + '\n'); (backup / 'recovery.json').chmod(0o600)
            checkpoint('prepared')
            touched = True
            if loaded: run(['launchctl', 'bootout', service])
            checkpoint('stop')
            for path in staged:
                os.replace(staged[path], path); committed.append(path); checkpoint('activate:' + path.name)
            run(['launchctl', 'enable', service]); checkpoint('enable')
            run(['launchctl', 'bootstrap', domain, str(agent)]); checkpoint('start')
            deadline = time.monotonic() + 10
            while True:
                status = run(['launchctl', 'print', service], check=False)
                if status.returncode == 0 and re.search(r'\bstate\s*=\s*running\b', status.stdout): break
                if time.monotonic() >= deadline: raise RuntimeError('LaunchAgent did not become running')
                time.sleep(0.1)
            checkpoint('health')
            return versions
        except BaseException:
            failures = []
            def attempt(action):
                try: action()
                except BaseException: failures.append('recovery step failed')
            if touched: attempt(lambda: run(['launchctl', 'bootout', service], check=False))
            for path in reversed(committed): attempt(lambda path=path: restore_file(path, saved[path]))
            if touched:
                attempt(lambda: run(['launchctl', 'disable' if disabled else 'enable', service]))
                if loaded: attempt(lambda: run(['launchctl', 'bootstrap', domain, str(agent)]))
            if new_runtime and not failures: shutil.rmtree(new_runtime)
            if failures: raise RuntimeError('macOS rollback incomplete; retain private recovery.json') from None
            raise
        finally:
            for path in staged.values(): path.unlink(missing_ok=True)


if __name__ == '__main__':
    repo = Path(__file__).resolve().parent.parent
    try:
        result = install_engine(repo, Path.home(), Path(os.environ.get('REACH_ENGINE_BINARY', repo / 'target/release/engine')),
                                Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None)
        print(json.dumps(result))
    except Exception:
        raise SystemExit('ENGINE_INSTALL_FAILED: inspect private ~/.reach/backups/macos-*/recovery.json; follow macOS recovery guide')
