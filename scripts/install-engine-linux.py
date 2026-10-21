#!/usr/bin/env python3
"""Stage and activate a Linux Engine installation, restoring it on failure."""

import fcntl
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parent))
from binary_identity import check_executable
from install_transaction import stage_file, restore_file

SERVICE = 'reach-engine.service'


def unit_text(home, engine_dir, system):
    def quoted(value):
        return json.dumps(str(value).replace('%', '%%'))

    network = 'Wants=network-online.target\nAfter=network-online.target\n' if system else ''
    return ('[Unit]\nDescription=Reach Engine\n' + network +
            '\n[Service]\nType=simple\n'
            f'Environment={quoted("HOME=" + str(home))}\n'
            f'ExecStart=/bin/bash {quoted(engine_dir / "start-engine.sh")}\n'
            'Restart=always\nRestartSec=5\nTimeoutStopSec=15\nUMask=0077\n'
            '\n[Install]\nWantedBy=' + ('multi-user.target' if system else 'default.target') + '\n')


def install_engine(engine_source, config_source, script_dir, home, unit_dir, system,
                   archive=None, runner=subprocess.run, checkpoint=lambda step: None):
    engine_dir = home / '.local/share/reach'
    config_dir = home / '.config/reach'
    reach_dir = home / '.reach'
    command = ['systemctl'] + ([] if system else ['--user'])

    def run(arguments, check=True):
        return runner(arguments, check=check, text=True, capture_output=True)

    def service(*arguments, check=True):
        return run(command + list(arguments), check=check)

    # All sources and the manager are checked before changing installed files.
    for source in [engine_source, config_source, script_dir / 'run-node.sh',
                   script_dir / 'install-node-runtime.py', script_dir / 'node-runtime.json', script_dir / 'engine-supervisor.mjs']:
        if not source.is_file():
            raise FileNotFoundError(f'Required installation artifact is missing: {source}')
    if not os.access(engine_source, os.X_OK):
        raise ValueError('Engine binary is not executable')
    if archive is not None and not archive.is_file():
        raise FileNotFoundError('Node archive is missing')
    check_executable(engine_source.read_bytes(), 'linux-x64')
    checkpoint('source-identity')
    engine_version = run([str(engine_source), '--version']).stdout.strip()
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', engine_version):
        raise ValueError('Engine returned an invalid component version')
    checkpoint('source-version')
    syntax = run(['/bin/bash', '-n', str(config_source)])
    if syntax.stderr.strip():
        raise ValueError('Engine configuration failed Bash syntax validation')
    service('show-environment')
    checkpoint('preflight')

    for directory in [engine_dir, config_dir, reach_dir, reach_dir / 'workspace', unit_dir]:
        directory.mkdir(parents=True, exist_ok=True)
    for directory in [engine_dir, config_dir, reach_dir, reach_dir / 'workspace']:
        directory.chmod(0o700)
    with (reach_dir / '.engine-install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return activate_install(engine_source, config_source, script_dir, home, unit_dir,
                                system, archive, run, service, engine_version, checkpoint)


def activate_install(engine_source, config_source, script_dir, home, unit_dir,
                     system, archive, run, service, engine_version, checkpoint):
    engine_dir = home / '.local/share/reach'
    config_dir = home / '.config/reach'
    reach_dir = home / '.reach'
    node_pointer = reach_dir / 'runtime/node'
    node_pointer.parent.mkdir(parents=True, exist_ok=True)
    targets = [engine_dir / 'engine', config_dir / 'engine.env', engine_dir / 'run-node.sh',
               engine_dir / 'start-engine.sh', reach_dir / 'versions.json',
               unit_dir / SERVICE, node_pointer, engine_dir / 'engine-supervisor.mjs']
    active = service('is-active', '--quiet', SERVICE, check=False).returncode == 0
    enabled = service('is-enabled', SERVICE, check=False).stdout.strip()
    if enabled not in ('enabled', 'enabled-runtime', 'disabled', 'static', 'not-found', ''):
        raise ValueError(f'Unsupported existing service enable state: {enabled}')
    backup = reach_dir / 'backups' / ('linux-' + uuid.uuid4().hex)
    backup.mkdir(parents=True, mode=0o700)
    saved = {}
    for index, target in enumerate(targets):
        saved[target] = None
        if os.path.lexists(target):
            snapshot = backup / str(index)
            shutil.copy2(target, snapshot, follow_symlinks=False)
            saved[target] = snapshot
    (backup / 'service-state.json').write_text(json.dumps({'active': active, 'enabled': enabled}) + '\n')
    recovery = {'schemaVersion': 1, 'service': SERVICE,
                'files': [{'target': str(target), 'backup': str(snapshot) if snapshot else None} for target, snapshot in saved.items()]}
    (backup / 'recovery.json').write_text(json.dumps(recovery, indent=2) + '\n')
    (backup / 'recovery.json').chmod(0o600)
    checkpoint('snapshot')

    staged = {}
    committed = []
    service_touched = False
    enable_attempted = False
    new_runtime = None
    try:
        with tempfile.TemporaryDirectory(prefix='.engine-install-', dir=reach_dir) as runtime_root:
            args = [sys.executable, str(script_dir / 'install-node-runtime.py'), '--root', runtime_root]
            if archive is not None:
                args += ['--archive', str(archive)]
            node = Path(run(args).stdout.strip()).resolve(strict=True)
            distribution = node.parent.parent
            if distribution.parent != Path(runtime_root).resolve() / 'runtime':
                raise ValueError('Runtime installer returned a path outside staging')
            node_version = run([str(node), '--version']).stdout.strip()
            if not node_version:
                raise ValueError('Node returned an empty version')
            runtime_target = node_pointer.parent / distribution.name
            if os.path.lexists(runtime_target):
                raise FileExistsError('Staged runtime release already exists')
            os.replace(distribution, runtime_target)
            new_runtime = runtime_target
        checkpoint('runtime')

        versions_file = reach_dir / 'versions.json'
        versions = json.loads(versions_file.read_text()) if versions_file.exists() else {}
        versions.update(engineVersion=engine_version, nodeVersion=node_version)
        mcp = engine_dir / 'mcp/dist/version.json'
        if not mcp.exists():
            mcp = engine_dir / 'mcp/package.json'
        if mcp.exists():
            versions['mcpVersion'] = json.loads(mcp.read_text())['version']
        else:
            versions.setdefault('mcpVersion', None)
        launcher = ('#!/usr/bin/env bash\nset -euo pipefail\nset -a\n'
                    'source "$HOME/.config/reach/engine.env"\nset +a\n'
                    'exec "$HOME/.local/share/reach/run-node.sh" "$HOME/.local/share/reach/engine-supervisor.mjs" "$HOME/.local/share/reach/engine"\n')
        inputs = [
            {'source': engine_source, 'mode': 0o755},
            {'source': config_source},
            {'source': script_dir / 'run-node.sh', 'mode': 0o755},
            {'content': launcher, 'mode': 0o700},
            {'content': json.dumps(versions, indent=2) + '\n'},
            {'content': unit_text(home, engine_dir, system), 'mode': 0o644},
            {'link': new_runtime.name},
            {'source': script_dir / 'engine-supervisor.mjs', 'mode': 0o644},
        ]
        for target, values in zip(targets, inputs):
            staged[target] = stage_file(target, **values)
            checkpoint('stage:' + target.name)
        # Nothing in the old installation has changed before this point.
        service_touched = True
        if active:
            service('stop', SERVICE)
        checkpoint('stop')
        for target in targets:
            os.replace(staged[target], target)
            committed.append(target)
            checkpoint('activate:' + target.name)
        service('daemon-reload')
        checkpoint('reload')
        enable_attempted = True
        service('enable', SERVICE)
        checkpoint('enable')
        service('restart', SERVICE)
        checkpoint('start')
        service('is-active', '--quiet', SERVICE)
        checkpoint('health')
        return versions
    except BaseException as error:
        failures = []

        def attempt(action):
            try:
                action()
            except BaseException as rollback_error:
                failures.append(str(rollback_error))

        if service_touched:
            attempt(lambda: service('stop', SERVICE))
        if enable_attempted:
            attempt(lambda: service('disable', SERVICE))
        for target in reversed(committed):
            attempt(lambda target=target: restore_file(target, saved[target]))
        if service_touched:
            attempt(lambda: service('daemon-reload'))
            if enable_attempted and enabled in ('enabled', 'enabled-runtime'):
                arguments = ['enable'] + (['--runtime'] if enabled == 'enabled-runtime' else []) + [SERVICE]
                attempt(lambda: service(*arguments))
            if active:
                attempt(lambda: service('restart', SERVICE))
                attempt(lambda: service('is-active', '--quiet', SERVICE))
        if new_runtime is not None and not failures:
            shutil.rmtree(new_runtime)
        if failures:
            raise RuntimeError(f'Installation failed: {error}; rollback errors: {failures}; recovery backup: {backup}') from error
        raise
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit('Usage: install-engine-linux.sh ENGINE_BINARY ENGINE_ENV [NODE_ARCHIVE]')
    system = os.geteuid() == 0
    home = Path.home()
    unit_dir = Path('/etc/systemd/system') if system else home / '.config/systemd/user'
    try:
        versions = install_engine(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(),
                                  Path(__file__).resolve().parent, home, unit_dir, system,
                                  Path(sys.argv[3]).resolve() if len(sys.argv) == 4 else None)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit('ENGINE_INSTALL_FAILED: inspect private ~/.reach/backups/linux-*/recovery.json and service-state.json; follow the Linux recovery guide')
    print(json.dumps(versions))
    print(f'Installed Reach Engine {versions["engineVersion"]} with private Node runtime (systemd).')


if __name__ == '__main__':
    main()
