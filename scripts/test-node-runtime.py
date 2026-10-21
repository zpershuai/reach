import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError
from executable_test_fixture import compile_fixture, platform_bytes
from binary_identity import host_platform, check_executable


spec = importlib.util.spec_from_file_location('node_runtime', Path(__file__).with_name('install-node-runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reach-runtime-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.reach = self.root / 'reach home'
        self.version = 'v24.21.0'
        self.target = host_platform()

    def test_cli_diagnostics_do_not_echo_private_paths_or_exception_text(self):
        sentinel = 'private-credential-body-args-output-sentinel'
        result = subprocess.run([sys.executable, str(Path(runtime.__file__)), '--root', str(self.reach),
                                 '--archive', str(self.root / sentinel)], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('NODE_RUNTIME_INSTALL_FAILED', result.stderr)
        self.assertNotIn(sentinel, result.stdout + result.stderr)

    def archive(self, version=None, target=None, broken=False, node_bytes=None):
        version = version or self.version
        target = target or self.target
        archive = self.root / f'node-{version}-{target}.tar.gz'
        data = node_bytes if node_bytes is not None else compile_fixture(self.root / 'fixture-node', version, broken=broken)
        with tarfile.open(archive, 'w:gz') as output:
            for name, content in [('node', data), ('npm', b'#!/bin/sh\n'), ('npx', b'#!/bin/sh\n')]:
                entry = tarfile.TarInfo(f'node-{version}-{target}/bin/{name}')
                entry.mode = 0o755
                entry.size = len(content)
                output.addfile(entry, io.BytesIO(content))
        manifest = {'version': version, 'sha256': {target: runtime.sha256(archive)}}
        return archive, manifest

    def test_install_and_reuse_without_network_or_system_node(self):
        archive, manifest = self.archive()
        node = runtime.install_runtime(self.reach, manifest, self.target, archive)
        current = node.parent.parent
        original = current.resolve()
        self.assertTrue(current.is_symlink())
        with patch.object(runtime, 'download', side_effect=AssertionError('unexpected download')):
            self.assertEqual(runtime.install_runtime(self.reach, manifest, self.target), node)
        self.assertEqual(current.resolve(), original)
        metadata = json.loads((current / '.reach-node.json').read_text())
        self.assertEqual(metadata['archiveSha256'], manifest['sha256'][self.target])

    def test_all_supported_platforms(self):
        for target in ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-x64-musl']:
            with self.subTest(target=target):
                check_executable(platform_bytes(target.removesuffix('-musl')), target)

    def test_download_uses_pinned_official_url(self):
        archive, manifest = self.archive()
        with patch.object(runtime, 'download', return_value=archive.read_bytes()) as download:
            runtime.install_runtime(self.reach, manifest, self.target)
        download.assert_called_once_with(
            f'https://nodejs.org/dist/{self.version}/node-{self.version}-{self.target}.tar.gz', binary=True, allowed=runtime.NODE_ORIGINS,
        )

    def test_failed_upgrade_preserves_current_runtime(self):
        archive, manifest = self.archive()
        node = runtime.install_runtime(self.reach, manifest, self.target, archive)
        original = node.resolve()
        upgrade, upgraded_manifest = self.archive(version='v24.22.0')
        with patch.object(runtime, 'download', side_effect=URLError('offline')):
            with self.assertRaises(URLError):
                runtime.install_runtime(self.reach, upgraded_manifest, self.target)
        self.assertEqual(node.resolve(), original)
        upgrade.write_bytes(b'corrupt download')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            runtime.install_runtime(self.reach, upgraded_manifest, self.target, upgrade)
        self.assertEqual(node.resolve(), original)
        broken, broken_manifest = self.archive(version='v24.23.0', broken=True)
        with self.assertRaises(runtime.subprocess.CalledProcessError):
            runtime.install_runtime(self.reach, broken_manifest, self.target, broken)
        self.assertEqual(node.resolve(), original)
        self.assertFalse(list(node.parent.parent.parent.glob('.node-install-*')))

    def test_corrupt_installed_binary_is_repaired(self):
        archive, manifest = self.archive()
        node = runtime.install_runtime(self.reach, manifest, self.target, archive)
        original = node.resolve()
        node.write_text('#!/bin/sh\nexit 1\n')
        runtime.install_runtime(self.reach, manifest, self.target, archive)
        self.assertNotEqual(node.resolve(), original)
        runtime.validate_node(node.parent.parent, self.version, self.target)

    def test_unsupported_platform_fails_before_download(self):
        _, manifest = self.archive()
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            runtime.install_runtime(self.reach, manifest, 'windows-x64')
        self.assertFalse(self.reach.exists())

    def test_invalid_metadata_is_repaired(self):
        archive, manifest = self.archive()
        node = runtime.install_runtime(self.reach, manifest, self.target, archive)
        (node.parent.parent / '.reach-node.json').write_text('[]')
        runtime.install_runtime(self.reach, manifest, self.target, archive)
        self.assertEqual(json.loads((node.parent.parent / '.reach-node.json').read_text())['version'], self.version)

    def test_wrong_format_and_truncated_runtime_never_execute_or_activate(self):
        for data in [b'#!/bin/sh\necho v24.21.0\n', platform_bytes('linux-x64')[:40]]:
            archive, manifest = self.archive(node_bytes=data)
            with patch.object(runtime.subprocess, 'check_output', side_effect=AssertionError('must not execute')):
                with self.assertRaises(ValueError): runtime.install_runtime(self.reach, manifest, self.target, archive)
            self.assertFalse((self.reach / 'runtime/node').exists())


if __name__ == '__main__':
    unittest.main()
