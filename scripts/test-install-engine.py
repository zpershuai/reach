import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install-engine.sh')
ASSETS = {
    ('Linux', 'x86_64'): 'engine-linux-x64-musl',
    ('Darwin', 'arm64'): 'engine-darwin-arm64',
    ('Darwin', 'x86_64'): 'engine-darwin-x64',
}
ASSET = ASSETS.get((platform.system(), platform.machine()))


@unittest.skipIf(ASSET is None or os.path.exists('/etc/openwrt_release'), 'no prebuilt Engine for this platform')
class InstallEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reach-install-engine-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.releases = self.root / 'releases'
        self.config = self.root / 'engine.env'
        self.config.write_text('REACH_ENGINE_ID=fixture\n')

    def publish(self, version, reported=None, digest=None):
        directory = self.releases / f'engine-v{version}'
        directory.mkdir(parents=True)
        binary = directory / ASSET
        binary.write_text(f'#!/bin/sh\necho {reported or version}\n')
        binary.chmod(0o755)
        digest = digest or hashlib.sha256(binary.read_bytes()).hexdigest()
        (directory / 'SHA256SUMS').write_text(f'{digest}  {ASSET}\n{"0" * 64}  engine-other\n')

    def run_installer(self, version=None, api=None):
        env = {**os.environ, 'REACH_INSTALL_DRY_RUN': '1',
               'REACH_RELEASE_BASE_URL': self.releases.as_uri()}
        env.pop('REACH_ENGINE_VERSION', None)
        if version:
            env['REACH_ENGINE_VERSION'] = version
        if api:
            path = self.root / 'releases.json'
            path.write_text(json.dumps(api))
            env['REACH_RELEASE_API_URL'] = path.as_uri()
        return subprocess.run(['bash', str(SCRIPT), str(self.config)], env=env,
                              capture_output=True, text=True, timeout=60)

    def test_verified_release_passes(self):
        self.publish('1.2.3')
        result = self.run_installer('engine-v1.2.3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'Verified {ASSET} 1.2.3.', result.stdout)

    def test_latest_stable_engine_tag_is_selected(self):
        self.publish('1.2.4')
        result = self.run_installer(api=[
            {'tag_name': 'engine-v9.9.9', 'prerelease': True},
            {'tag_name': 'gateway-v5.0.0'},
            {'tag_name': 'engine-v1.2.4'},
            {'tag_name': 'engine-v1.2.3'},
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('1.2.4', result.stdout)

    def test_checksum_mismatch_is_refused(self):
        self.publish('1.2.3', digest='f' * 64)
        result = self.run_installer('1.2.3')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Checksum mismatch', result.stderr)

    def test_reported_version_mismatch_is_refused(self):
        self.publish('1.2.3', reported='1.2.2')
        result = self.run_installer('1.2.3')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expected 1.2.3', result.stderr)

    def test_invalid_version_is_refused(self):
        result = self.run_installer('latest')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid Engine version', result.stderr)


if __name__ == '__main__':
    unittest.main()
