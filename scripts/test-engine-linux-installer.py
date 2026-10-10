import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('linux_installer', Path(__file__).with_name('install-engine-linux.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reach-install-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.scripts = self.root / 'scripts'
        self.units = self.root / 'units'
        self.scripts.mkdir()
        self.units.mkdir()
        self.engine = self.root / 'new-engine'
        self.engine.write_text('#!/bin/sh\necho engine-new\n')
        self.engine.chmod(0o755)
        self.config = self.root / 'new.env'
        self.config.write_text('REACH_ENGINE_ID=fixture\n')
        for source in ['run-node.sh', 'install-node-runtime.py', 'node-runtime.json']:
            (self.scripts / source).write_text('fixture')
        engine_dir = self.home / '.local/share/reach'
        config_dir = self.home / '.config/reach'
        reach_dir = self.home / '.reach'
        self.targets = [engine_dir / 'engine', config_dir / 'engine.env',
                        engine_dir / 'run-node.sh', engine_dir / 'start-engine.sh',
                        reach_dir / 'versions.json', self.units / installer.SERVICE,
                        reach_dir / 'runtime/node']
        for target in self.targets:
            target.parent.mkdir(parents=True, exist_ok=True)
        for target in self.targets[:-1]:
            target.write_text(json.dumps({'engineVersion': 'old', 'custom': True}) if target.name == 'versions.json' else 'old-' + target.name)
            target.chmod(0o640)
        self.targets[0].chmod(0o4750)
        old_runtime = reach_dir / 'runtime/old-node'
        (old_runtime / 'bin').mkdir(parents=True)
        (old_runtime / 'bin/node').write_text('old-node')
        self.targets[-1].symlink_to('old-node')
        self.active = True
        self.enabled = 'enabled'
        self.calls = []
        self.fail_command = None

    def snapshot(self):
        return {str(target): ('link', os.readlink(target)) if target.is_symlink()
                else ('file', target.read_bytes(), target.stat().st_mode & 0o7777)
                for target in self.targets if os.path.lexists(target)}

    def runner(self, command, check=True, **kwargs):
        if 'install-node-runtime.py' in command[1]:
            root = Path(command[command.index('--root') + 1])
            distribution = root / 'runtime' / ('node-new-' + uuid.uuid4().hex)
            (distribution / 'bin').mkdir(parents=True)
            node = distribution / 'bin/node'
            node.write_text('node-new')
            return subprocess.CompletedProcess(command, 0, str(node) + '\n', '')
        if command[0] == str(self.engine):
            return subprocess.CompletedProcess(command, 0, 'engine-new\n', '')
        if command[0] == '/bin/bash':
            return subprocess.run(command, check=check, **kwargs)
        if command[0] != 'systemctl':
            return subprocess.CompletedProcess(command, 0, 'v24.21.0\n', '')
        action = command[2] if command[1] == '--user' else command[1]
        self.calls.append(action)
        code = 0
        output = ''
        if action == self.fail_command:
            self.fail_command = None
            if action == 'restart':
                self.active = False
            if action == 'enable':
                self.enabled = 'enabled'
            raise subprocess.CalledProcessError(1, command)
        if action == 'is-active':
            code = 0 if self.active else 3
        elif action == 'is-enabled':
            output = self.enabled
            code = 0 if self.enabled.startswith('enabled') else 1
        elif action == 'stop':
            self.active = False
        elif action == 'restart':
            self.active = True
        elif action == 'enable':
            self.enabled = 'enabled-runtime' if '--runtime' in command else 'enabled'
        elif action == 'disable':
            self.enabled = 'disabled'
        if check and code:
            raise subprocess.CalledProcessError(code, command)
        return subprocess.CompletedProcess(command, code, output, '')

    def install(self, checkpoint=lambda step: None, system=False):
        return installer.install_engine(self.engine, self.config, self.scripts, self.home,
                                        self.units, system, runner=self.runner, checkpoint=checkpoint)

    def test_successful_upgrade_stages_everything_before_stopping(self):
        before = self.snapshot()
        def checkpoint(step):
            if step.startswith('stage:'):
                self.assertEqual(self.snapshot(), before)
                self.assertTrue(self.active)
        versions = self.install(checkpoint)
        self.assertEqual(versions['engineVersion'], 'engine-new')
        self.assertTrue(versions['custom'])
        self.assertTrue(self.active)
        self.assertEqual(self.enabled, 'enabled')
        self.assertEqual(self.targets[0].read_bytes(), self.engine.read_bytes())
        self.assertEqual(self.targets[0].stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.targets[1].stat().st_mode & 0o777, 0o600)
        self.assertIn('old-node', [path.name for path in self.targets[-1].parent.iterdir()])
        self.assertFalse(list(self.home.rglob('.reach-install-*')))

    def test_each_install_step_rolls_back_all_files_runtime_and_service(self):
        steps = ['preflight', 'snapshot', 'runtime', 'stop', 'reload', 'enable', 'start', 'health']
        steps += ['stage:' + target.name for target in self.targets]
        steps += ['activate:' + target.name for target in self.targets]
        for step in steps:
            with self.subTest(step=step):
                before = self.snapshot()
                self.calls.clear()
                def fail(current):
                    if current == step:
                        raise OSError('injected failure: ' + step)
                with self.assertRaises(OSError):
                    self.install(fail)
                self.assertEqual(self.snapshot(), before)
                self.assertTrue(self.active)
                self.assertEqual(self.enabled, 'enabled')
                self.assertFalse(list(self.home.rglob('.reach-install-*')))
                if step in ['preflight', 'snapshot', 'runtime'] or step.startswith('stage:'):
                    self.assertNotIn('stop', self.calls)

    def test_failed_service_commands_restore_old_installation(self):
        for command in ['stop', 'daemon-reload', 'enable', 'restart', 'is-active']:
            with self.subTest(command=command):
                before = self.snapshot()
                # Fail the final health check rather than the initial observation.
                def checkpoint(step):
                    if command == 'is-active' and step == 'start':
                        self.fail_command = command
                if command != 'is-active':
                    self.fail_command = command
                with self.assertRaises(subprocess.CalledProcessError):
                    self.install(checkpoint)
                self.assertEqual(self.snapshot(), before)
                self.assertTrue(self.active)
                self.assertEqual(self.enabled, 'enabled')

    def test_inactive_disabled_service_and_fresh_install_are_restored(self):
        for fresh in [False, True]:
            with self.subTest(fresh=fresh):
                if fresh:
                    for target in self.targets:
                        target.unlink()
                self.active = False
                self.enabled = 'disabled'
                before = self.snapshot()
                def fail(step):
                    if step == 'start':
                        raise OSError('after restart')
                with self.assertRaises(OSError):
                    self.install(fail, system=True)
                self.assertEqual(self.snapshot(), before)
                self.assertFalse(self.active)
                self.assertEqual(self.enabled, 'disabled')

    def test_missing_artifacts_and_invalid_config_do_not_stop_the_old_service(self):
        before = self.snapshot()
        (self.scripts / 'run-node.sh').unlink()
        with self.assertRaises(FileNotFoundError):
            self.install()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.calls, [])
        (self.scripts / 'run-node.sh').write_text('fixture')
        self.config.write_text('invalid=(\n')
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            self.install()
        self.assertTrue(self.active)
        self.assertEqual(self.snapshot(), before)

    def test_rollback_failure_reports_and_retains_recovery_backup(self):
        def fail(step):
            if step == 'start':
                raise OSError('install failed')
        with patch.object(installer, 'restore_file', side_effect=OSError('restore failed')):
            with self.assertRaisesRegex(RuntimeError, 'rollback errors.*recovery backup'):
                self.install(fail)
        self.assertTrue(list((self.home / '.reach/backups').glob('*/service-state.json')))


if __name__ == '__main__':
    unittest.main()
