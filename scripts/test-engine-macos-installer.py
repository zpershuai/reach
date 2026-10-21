import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid
from executable_test_fixture import platform_bytes

spec = importlib.util.spec_from_file_location('macos_installer', Path(__file__).with_name('install-engine-macos.py'))
installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)


class MacInstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='reach-macos-install-test-'); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name); self.home = self.root / 'home'; self.repo = self.root / 'repo'
        (self.repo / 'scripts').mkdir(parents=True)
        for name in ['run-node.sh', 'install-node-runtime.py', 'engine-supervisor.mjs']: (self.repo / 'scripts' / name).write_text('fixture')
        self.source = self.root / 'engine'; self.source.write_bytes(platform_bytes('darwin-arm64'))
        self.config = self.root / 'engine.env'; self.config.write_text('REACH_ENGINE_ID=fixture\n')
        directory = self.home / '.local/share/reach'; config_dir = self.home / '.config/reach'; reach = self.home / '.reach'
        self.label = 'org.example.reach-fixture'
        self.agent = self.home / 'Library/LaunchAgents' / (self.label + '.plist')
        self.paths = [directory / 'engine', config_dir / 'engine.env', directory / 'run-node.sh', directory / 'start-engine.sh', reach / 'versions.json', self.agent, directory / 'engine-supervisor.mjs', reach / 'runtime/node']
        for path in self.paths: path.parent.mkdir(parents=True, exist_ok=True)
        for path in self.paths[:-1]: path.write_text('old-' + path.name); path.chmod(0o640)
        self.agent.write_bytes(plistlib.dumps({'Label': self.label, 'ProgramArguments': [str(directory / 'start-engine.sh')]}))
        (reach / 'versions.json').write_text('{"engineVersion":"old","custom":true}')
        (reach / 'runtime/old-node/bin').mkdir(parents=True); (reach / 'runtime/old-node/bin/node').write_text('old')
        self.paths[-1].symlink_to('old-node')
        self.loaded = True; self.disabled = False; self.calls = []; self.fail_command = None

    def snapshot(self):
        return {str(path): ('link', os.readlink(path)) if path.is_symlink() else ('file', path.read_bytes(), path.stat().st_mode & 0o7777)
                for path in self.paths if os.path.lexists(path)}

    def runner(self, command, check=True, **kwargs):
        if command[0] == str(self.source): return subprocess.CompletedProcess(command, 0, '1.2.3\n', '')
        if command[0] == '/bin/bash': return subprocess.run(command, check=check, **kwargs)
        if len(command) > 1 and command[1].endswith('install-node-runtime.py'):
            root = Path(command[command.index('--root') + 1]); node = root / 'runtime' / ('node-new-' + uuid.uuid4().hex) / 'bin/node'
            node.parent.mkdir(parents=True); node.write_text('fixture-node'); return subprocess.CompletedProcess(command, 0, str(node) + '\n', '')
        if command[0] != 'launchctl': return subprocess.CompletedProcess(command, 0, 'v24.21.0\n', '')
        action = command[1]; self.calls.append(action)
        if self.fail_command == action:
            self.fail_command = None; raise subprocess.CalledProcessError(1, command)
        output = ''; code = 0
        if action == 'print': code = 0 if self.loaded else 113; output = 'state = running\n' if self.loaded else ''
        if action == 'print-disabled': output = f'"{self.label}" => {str(self.disabled).lower()}\n'
        if action == 'bootout': self.loaded = False
        if action == 'bootstrap': self.loaded = True
        if action in ['enable', 'disable']: self.disabled = action == 'disable'
        if check and code: raise subprocess.CalledProcessError(code, command)
        return subprocess.CompletedProcess(command, code, output, '')

    def install(self, checkpoint=lambda step: None):
        return installer.install_engine(self.repo, self.home, self.source, self.config, runner=self.runner,
                                        checkpoint=checkpoint, target='darwin-arm64', uid=501)

    def test_stages_all_files_before_unloading_and_preserves_custom_label(self):
        before = self.snapshot()
        def checkpoint(step):
            if step == 'prepared': self.assertEqual(self.snapshot(), before); self.assertTrue(self.loaded)
        result = self.install(checkpoint)
        self.assertEqual(result['engineVersion'], '1.2.3'); self.assertTrue(result['custom'])
        self.assertEqual(self.paths[0].read_bytes(), self.source.read_bytes()); self.assertTrue(self.loaded)
        self.assertEqual(plistlib.loads(self.agent.read_bytes())['Label'], self.label)
        self.assertFalse(list(self.home.rglob('.reach-install-*')))

    def test_each_stage_and_activation_failure_restores_files_runtime_and_launchd_state(self):
        steps = ['source-identity', 'runtime', 'prepared', 'stop', 'enable', 'start', 'health']
        steps += ['stage:' + path.name for path in self.paths] + ['activate:' + path.name for path in self.paths]
        for step in steps:
            with self.subTest(step=step):
                before = self.snapshot(); self.calls.clear()
                def fail(current):
                    if current == step: raise OSError('injected stage failure')
                with self.assertRaises(OSError): self.install(fail)
                self.assertEqual(self.snapshot(), before); self.assertTrue(self.loaded); self.assertFalse(self.disabled)
                self.assertFalse(list(self.home.rglob('.reach-install-*')))
                if step in ['source-identity', 'runtime', 'prepared'] or step.startswith('stage:'): self.assertNotIn('bootout', self.calls)

    def test_bootstrap_failure_and_disabled_unloaded_state_are_restored(self):
        for loaded, disabled in [(True, False), (False, True)]:
            self.loaded, self.disabled = loaded, disabled; before = self.snapshot(); self.fail_command = 'bootstrap'
            with self.assertRaises(subprocess.CalledProcessError): self.install()
            self.assertEqual(self.snapshot(), before); self.assertEqual((self.loaded, self.disabled), (loaded, disabled))

    def test_fresh_install_failure_removes_new_targets_but_retains_workspace(self):
        for path in self.paths: path.unlink()
        self.loaded = False; before = self.snapshot()
        def fail(step):
            if step == 'start': raise OSError('injected start failure')
        with self.assertRaises(OSError): self.install(fail)
        self.assertEqual(self.snapshot(), before); self.assertFalse(self.loaded)
        self.assertTrue((self.home / '.reach/workspace').is_dir())
        self.assertEqual([path.name for path in (self.home / '.reach/runtime').iterdir()], ['old-node'])

    def test_rollback_failure_retains_private_recovery_mapping(self):
        def fail(step):
            if step == 'start': raise OSError('injected start failure')
        with patch.object(installer, 'restore_file', side_effect=OSError('recovery failure')):
            with self.assertRaisesRegex(RuntimeError, 'rollback incomplete'): self.install(fail)
        records = list((self.home / '.reach/backups').glob('*/recovery.json')); self.assertEqual(len(records), 1)
        self.assertTrue(json.loads(records[0].read_text())['files'])
        self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)

    def test_duplicate_or_changed_label_is_rejected_without_modifying_installation(self):
        before = self.snapshot()
        with patch.dict(os.environ, {'REACH_LAUNCHD_LABEL': 'org.example.different'}):
            with self.assertRaises(ValueError): self.install()
        self.assertEqual(self.snapshot(), before); self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()
