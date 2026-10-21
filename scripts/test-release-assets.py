#!/usr/bin/env python3
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib
import unittest
from executable_test_fixture import platform_bytes


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


assets = load('assets', 'verify-release-assets.py')
metadata = load('metadata', 'release-metadata.py')
merger = load('merger', 'merge-engine-notices.py')


class AssetTests(unittest.TestCase):
    def tar(self, path, files):
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name); entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))

    def fixture(self, root):
        locked = [p for p in tomllib.loads((assets.ROOT / 'Cargo.lock').read_text())['package'] if p.get('source', '').startswith('registry+')]
        self.files = {}
        for asset, target in assets.TARGETS.items():
            binary = platform_bytes(asset.removeprefix('engine-').removesuffix('-musl'))
            (root / asset).write_bytes(binary)
            (root / (asset + '.NOTICES.txt')).write_text('Fixture complete notice summary')
            files = {f"LICENSES/crates/{p['name']}-{p['version']}/LICENSE": b'Fixture upstream notice' for p in locked}
            inventory = [dict(p, license='MIT') for p in locked]
            files.update({'LICENSES/inventory.json': json.dumps(inventory).encode(),
                          'LICENSES/platform.json': json.dumps({'target': target, 'rustVersion': '1.96.0', 'componentVersion': '1.2.3', 'executableSha256': hashlib.sha256(binary).hexdigest()}).encode(),
                          'LICENSES/runtimes/rust/COPYRIGHT-library.html': b'Fixture std copyright',
                          'LICENSES/runtimes/musl-COPYRIGHT.txt': b'Fixture musl copyright',
                          'LICENSES/runtimes/rust-LICENSE-MIT.txt': b'Fixture MIT',
                          'LICENSES/runtimes/rust-LICENSE-APACHE.txt': b'Fixture Apache'})
            self.files[asset] = files
            self.tar(root / (asset + '.licenses.tgz'), files)
        merger.merge(root)
        metadata.create_manifest(root, 'engine', '1.2.3', metadata.public_source('example/reach-source', 'a' * 40, False), {'rust': '1.96.0', 'node': '24.21.0', 'python': '3.14.5'})

    def test_every_platform_notice_and_executable_binding_is_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root)
            self.assertEqual(assets.complete(root)['component'], 'engine')
            for case in ['missing-runtime', 'wrong-version', 'wrong-target', 'changed-binary', 'missing-crate']:
                asset = 'engine-darwin-x64'
                files = self.files[asset].copy()
                identity = json.loads(files['LICENSES/platform.json'])
                if case == 'missing-runtime': del files['LICENSES/runtimes/rust/COPYRIGHT-library.html']
                if case == 'missing-crate': del files[next(n for n in files if n.startswith('LICENSES/crates/'))]
                if case == 'wrong-version': identity['componentVersion'] = '9.9.9'
                if case == 'wrong-target': identity['target'] = 'aarch64-apple-darwin'
                if case == 'changed-binary': identity['executableSha256'] = 'b' * 64
                files['LICENSES/platform.json'] = json.dumps(identity).encode()
                self.tar(root / (asset + '.licenses.tgz'), files)
                with self.subTest(case=case), self.assertRaises(ValueError): assets.engine_platform(root, asset, '1.2.3')
            (root / 'unapproved.env').write_text('fixture')
            with self.assertRaises(ValueError): assets.complete(root)
            (root / 'unapproved.env').unlink()
            (root / 'engine-linux-x64-musl.NOTICES.txt').unlink()
            with self.assertRaises(ValueError): assets.complete(root)

    def test_checksum_manifest_cannot_be_replaced_or_omitted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root)
            (root / 'SHA256SUMS').write_text('')
            with self.assertRaisesRegex(ValueError, 'Checksum'): assets.complete(root)


if __name__ == '__main__': unittest.main()
