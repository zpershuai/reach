import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest
from executable_test_fixture import compile_fixture
from binary_identity import check_executable

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
        compile_fixture(binary, reported or version)
        binary.chmod(0o755)
        digest = digest or hashlib.sha256(binary.read_bytes()).hexdigest()
        (directory / 'SHA256SUMS').write_text(f'{digest}  {ASSET}\n{"0" * 64}  engine-other\n')

    def run_installer(self, version=None, api=None):
        env = {**os.environ, 'REACH_INSTALL_DRY_RUN': '1', 'REACH_RELEASE_TEST_MODE': '1',
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

    def test_untrusted_version_output_is_not_echoed_to_diagnostics(self):
        sentinel = 'private-credential-body-output-sentinel'
        self.publish('1.2.3', reported=sentinel)
        binary = self.releases / 'engine-v1.2.3' / ASSET
        compile_fixture(binary, sentinel, stderr=sentinel)
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        (binary.parent / 'SHA256SUMS').write_text(f'{digest}  {ASSET}\n')
        result = self.run_installer('1.2.3')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ENGINE_VERSION_MISMATCH', result.stderr)
        self.assertNotIn(sentinel, result.stdout + result.stderr)

    def test_invalid_version_is_refused(self):
        result = self.run_installer('latest')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid Engine version', result.stderr)

    def test_shared_executable_identity_matrix(self):
        cases = json.loads((SCRIPT.parent.parent / 'fixtures/executable-identity.json').read_text())
        for case in cases:
            with self.subTest(case=case['id']):
                if case['valid']:
                    check_executable(bytes.fromhex(case['hex']), case['target'])
                else:
                    with self.assertRaises(ValueError): check_executable(bytes.fromhex(case['hex']), case['target'])

    def test_openwrt_elf_checker_matches_shared_rejection_matrix(self):
        cases = json.loads((SCRIPT.parent.parent / 'fixtures/executable-identity.json').read_text())
        for case in cases:
            path = self.root / 'fixture-executable'; path.write_bytes(bytes.fromhex(case['hex']))
            result = subprocess.run(['sh', str(SCRIPT.with_name('verify-elf-x64.sh')), str(path)], capture_output=True)
            # "wrong-os" is a valid Linux x64 ELF presented to a Mach-O consumer.
            expected = case['id'] in ('linux-x64', 'wrong-os')
            self.assertEqual(result.returncode == 0, expected, case['id'])

    def test_wrong_format_architecture_and_truncation_are_rejected_before_version_probe(self):
        self.publish('1.2.3')
        binary = self.releases / 'engine-v1.2.3' / ASSET
        original = binary.read_bytes()
        wrong_arch = bytearray(original)
        wrong_arch[18:20] = (183).to_bytes(2, 'little') if original.startswith(b'\x7fELF') else wrong_arch[18:20]
        if original.startswith(b'\xcf\xfa\xed\xfe'):
            wrong_arch[4:8] = (0x1000007 if platform.machine() == 'arm64' else 0x100000c).to_bytes(4, 'little')
        marker = self.root / 'executed'
        script = f'#!/bin/sh\ntouch "{marker}"\necho 1.2.3\n'.encode()
        for data in [script, bytes(wrong_arch), original[:30]]:
            with self.subTest(size=len(data)):
                binary.write_bytes(data)
                (binary.parent / 'SHA256SUMS').write_text(f'{hashlib.sha256(data).hexdigest()}  {ASSET}\n')
                result = self.run_installer('1.2.3')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('EXECUTABLE_IDENTITY_REJECTED', result.stderr)
                self.assertFalse(marker.exists())

    def test_duplicate_and_malformed_selected_checksums_are_refused(self):
        self.publish('1.2.3')
        directory = self.releases / 'engine-v1.2.3'
        line = (directory / 'SHA256SUMS').read_text().splitlines()[0]
        for sums in [line + '\n' + line + '\n', line + ' extra\n', line + '\n' + line + ' extra\n']:
            (directory / 'SHA256SUMS').write_text(sums)
            result = self.run_installer('1.2.3')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('no single valid digest', result.stderr)


if __name__ == '__main__':
    unittest.main()
