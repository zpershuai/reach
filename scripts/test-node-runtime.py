import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError


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
        self.target = 'darwin-arm64'

    def archive(self, version=None, target=None, broken=False):
        version = version or self.version
        target = target or self.target
        archive = self.root / f'node-{version}-{target}.tar.gz'
        script = '#!/bin/sh\n'
        if broken:
            script += 'exit 1\n'
        else:
            node_target = target[:-5] if target.endswith('-musl') else target
            script += f'if [ "$1" = --version ]; then echo {version}; else echo {node_target}; fi\n'
        with tarfile.open(archive, 'w:gz') as output:
            for name, content in [('node', script), ('npm', '#!/bin/sh\n'), ('npx', '#!/bin/sh\n')]:
                entry = tarfile.TarInfo(f'node-{version}-{target}/bin/{name}')
                entry.mode = 0o755
                data = content.encode()
                entry.size = len(data)
                output.addfile(entry, io.BytesIO(data))
        manifest = {'version': version, 'sha256': {target: runtime.sha256(archive)}}
        return archive, manifest

    def test_install_and_reuse_without_network_or_system_node(self):
        archive, manifest = self.archive()
        node = runtime.install_runtime(self.reach, manifest, self.target, archive)
        current = node.parent.parent
        original = current.resolve()
        self.assertTrue(current.is_symlink())
        with patch.object(runtime.urllib.request, 'urlopen', side_effect=AssertionError('unexpected download')):
            self.assertEqual(runtime.install_runtime(self.reach, manifest, self.target), node)
        self.assertEqual(current.resolve(), original)
        metadata = json.loads((current / '.reach-node.json').read_text())
        self.assertEqual(metadata['archiveSha256'], manifest['sha256'][self.target])

    def test_all_supported_platforms(self):
        for target in ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-x64-musl']:
            with self.subTest(target=target):
                archive, manifest = self.archive(target=target)
                node = runtime.install_runtime(self.reach, manifest, target, archive)
                self.assertTrue(node.is_file())

    def test_download_uses_pinned_official_url(self):
        archive, manifest = self.archive()
        with patch.object(runtime.urllib.request, 'urlopen', return_value=io.BytesIO(archive.read_bytes())) as download:
            runtime.install_runtime(self.reach, manifest, self.target)
        download.assert_called_once_with(
            f'https://nodejs.org/dist/{self.version}/node-{self.version}-{self.target}.tar.gz', timeout=60,
        )

    def test_failed_upgrade_preserves_current_runtime(self):
        archive, manifest = self.archive()
        node = runtime.install_runtime(self.reach, manifest, self.target, archive)
        original = node.resolve()
        upgrade, upgraded_manifest = self.archive(version='v24.22.0')
        with patch.object(runtime.urllib.request, 'urlopen', side_effect=URLError('offline')):
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


if __name__ == '__main__':
    unittest.main()
