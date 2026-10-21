import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from executable_test_fixture import platform_bytes

SCRIPT = Path(__file__).with_name('install-engine-openwrt.sh')


class OpenWrtInstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='reach-openwrt-fixture-'); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name); (self.root / '.reach-installer-fixture').touch()
        self.reach = self.root / 'root/.reach'; self.config = self.root / 'etc/reach'; self.init = self.root / 'etc/init.d'
        for directory in [self.reach / 'runtime/old/bin', self.config, self.init]: directory.mkdir(parents=True)
        self.targets = [self.reach / 'engine', self.reach / 'start-engine.sh', self.reach / 'run-node.sh', self.reach / 'versions.json', self.config / 'engine.env', self.init / 'reach-engine', self.reach / 'engine-supervisor.mjs', self.reach / 'runtime/node']
        for path in self.targets[:-1]: path.write_text('old-' + path.name); path.chmod(0o700 if path.name == 'reach-engine' else 0o600)
        self.targets[-1].symlink_to('old')
        (self.root / 'active').touch(); (self.root / 'enabled').touch()
        self.engine = self.root / 'new-engine'; self.engine.write_bytes(platform_bytes('linux-x64'))
        self.env_file = self.root / 'new.env'; self.env_file.write_text('REACH_ENGINE_ID=fixture\n')
        self.archive = self.root / 'node.tgz'; distribution = 'node-v24.21.0-linux-x64-musl'
        with tarfile.open(self.archive, 'w:gz') as output:
            for name in ['bin/node', 'lib/ld-musl-x86_64.so.1', 'bin/npm', 'bin/npx']:
                data = platform_bytes('linux-x64') if name in ['bin/node', 'lib/ld-musl-x86_64.so.1'] else b'fixture'
                entry = tarfile.TarInfo(distribution + '/' + name); entry.mode = 0o755; entry.size = len(data); output.addfile(entry, io.BytesIO(data))
        (self.root / 'node-runtime.json').write_text(json.dumps({'version':'v24.21.0', 'sha256':{'openwrt-x64':hashlib.sha256(self.archive.read_bytes()).hexdigest()}}))
        self.tool('probe', '''#!/bin/sh
if [ "$2" = -p ]; then echo linux-x64; elif [ "$(basename "$1")" = new-engine ]; then echo 1.2.3; else echo v24.21.0; fi
''')
        self.tool('jsonfilter', '''#!/usr/bin/env python3
import json,sys
data=json.load(open(sys.argv[2])); print(data['version'] if sys.argv[4]=='@.version' else data['sha256']['openwrt-x64'])
''')
        # Exercise BusyBox mv -T semantics on macOS without invoking a supervisor.
        self.tool('mv', '''#!/usr/bin/env python3
import os,sys
args=[arg for arg in sys.argv[1:] if not arg.startswith('-')]
if os.environ.get('FAIL_RESTORE')=='1' and '.restore-' in args[-2]: sys.exit(1)
os.replace(args[-2],args[-1])
''')
        self.tool('supervisor', '''#!/bin/sh
set -eu
root=$(dirname "$0")
echo "$1" >> "$root/calls"
if [ "${FAIL_SERVICE:-}" = "$1" ] && [ ! -f "$root/failed-once" ]; then touch "$root/failed-once"; exit 1; fi
case "$1" in
status) [ -f "$root/active" ] ;;
enabled) [ -f "$root/enabled" ] ;;
start) touch "$root/active" ;;
stop) rm -f "$root/active" ;;
enable) touch "$root/enabled" ;;
disable) rm -f "$root/enabled" ;;
esac
''')

    def tool(self, name, content):
        path = self.root / name; path.write_text(content); path.chmod(0o755)

    def snapshot(self):
        return {str(path): ('link',os.readlink(path)) if path.is_symlink() else ('file',path.read_bytes(),path.stat().st_mode & 0o7777)
                for path in self.targets if os.path.lexists(path)}

    def install(self, **overrides):
        env = {**os.environ, 'REACH_INSTALL_TEST_MODE':'1', 'REACH_INSTALL_TEST_ROOT':str(self.root), 'PATH':str(self.root)+os.pathsep+os.environ['PATH'], **overrides}
        return subprocess.run(['sh',str(SCRIPT),str(self.engine),str(self.env_file),str(self.archive)], env=env, capture_output=True, text=True, timeout=20)

    def test_success_preserves_old_runtime_and_installs_private_config(self):
        result = self.install(); self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.targets[0].read_bytes(),self.engine.read_bytes()); self.assertEqual(self.targets[4].stat().st_mode & 0o777,0o600)
        self.assertTrue((self.reach/'runtime/old').is_dir()); self.assertTrue((self.root/'active').exists())
        self.assertFalse(list(self.root.rglob('*.new-*')))

    def test_every_checkpoint_restores_files_runtime_service_and_enable_state(self):
        for step in ['snapshot','runtime','prepared','stop', *[f'activate-{index}' for index in range(1,9)],'enable','start','health']:
            with self.subTest(step=step):
                before=self.snapshot(); result=self.install(REACH_INSTALL_FAIL_AT=step)
                self.assertNotEqual(result.returncode,0); self.assertEqual(self.snapshot(),before)
                self.assertTrue((self.root/'active').exists()); self.assertTrue((self.root/'enabled').exists())
                self.assertEqual(sorted(path.name for path in (self.reach/'runtime').iterdir()),['node','old'])
                self.assertFalse(list(self.root.rglob('*.new-*')))

    def test_start_command_failure_restores_old_install_and_fresh_failure_cleans_targets(self):
        before=self.snapshot(); result=self.install(FAIL_SERVICE='start')
        self.assertNotEqual(result.returncode,0); self.assertEqual(self.snapshot(),before); self.assertTrue((self.root/'active').exists())
        for path in self.targets: path.unlink()
        for name in ['active','enabled','failed-once']: (self.root/name).unlink(missing_ok=True)
        result=self.install(FAIL_SERVICE='start'); self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.snapshot(),{}); self.assertFalse((self.root/'active').exists()); self.assertFalse((self.root/'enabled').exists())
        self.assertTrue((self.reach/'workspace').is_dir())

    def test_bad_archive_or_executable_never_stops_the_previous_service(self):
        before=self.snapshot(); self.archive.write_bytes(b'truncated fixture')
        result=self.install(); self.assertNotEqual(result.returncode,0); self.assertEqual(self.snapshot(),before)
        self.assertFalse((self.root/'calls').exists()); self.assertTrue((self.root/'active').exists())

    def test_failed_rollback_preserves_private_recovery_artifacts(self):
        result=self.install(REACH_INSTALL_FAIL_AT='start',FAIL_RESTORE='1')
        self.assertNotEqual(result.returncode,0); self.assertIn('INSTALL_ROLLBACK_FAILED',result.stderr)
        records=list((self.reach/'backups').glob('*/targets')); self.assertEqual(len(records),1)
        self.assertEqual(records[0].stat().st_mode & 0o777,0o600)
        self.assertTrue((records[0].parent/'service-state').exists()); self.assertTrue((records[0].parent/'1').exists())


if __name__ == '__main__': unittest.main()
