import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("package_notices", Path(__file__).with_name("package-notices.py"))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)
merge_spec = importlib.util.spec_from_file_location('merge_notices', Path(__file__).with_name('merge-engine-notices.py'))
merger = importlib.util.module_from_spec(merge_spec); merge_spec.loader.exec_module(merger)


class NoticeTests(unittest.TestCase):
    def package(self, root, extra=None):
        archive = root / "fixture-1.2.3.crate"
        files = {"Cargo.toml": b'[package]\nname="fixture"\nversion="1.2.3"\nlicense="MIT"\n',
                 "LICENSES/MIT.txt": b"Fixture legal notice", "src/lib.rs": b"PRIVATE_SOURCE_MUST_NOT_BE_COPIED"}
        files.update(extra or {})
        with tarfile.open(archive, "w:gz") as tar:
            for name, data in files.items():
                entry = tarfile.TarInfo("fixture-1.2.3/" + name)
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
        return {"name": "fixture", "version": "1.2.3", "checksum": hashlib.sha256(archive.read_bytes()).hexdigest()}

    def test_archived_notices_are_copied_without_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = self.package(root)
            result = notices.crate_licenses(package, root / "out", root / "empty-cargo", root)
            self.assertEqual(result["license"], "MIT")
            self.assertTrue((root / "out/crates/fixture-1.2.3/LICENSES/MIT.txt").exists())
            self.assertFalse((root / "out/crates/fixture-1.2.3/src").exists())

    def test_wrong_upstream_digest_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = self.package(root)
            package["checksum"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "checksum differs"):
                notices.crate_licenses(package, root / "out", root / "empty-cargo", root)
            self.assertFalse((root / "out").exists())

    def test_unsafe_legal_archive_paths_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = self.package(root, {"LICENSES/../../escape": b"unsafe"})
            with self.assertRaisesRegex(ValueError, "Unsafe license path"):
                notices.crate_licenses(package, root / "out", root / "empty-cargo", root)
            self.assertFalse((root / "escape").exists())

    def test_missing_compiler_version_fails_before_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "LICENSE").write_text("project license")
            with self.assertRaisesRegex(ValueError, "exact stable compiler version"):
                notices.collect("engine", root / "out", source=root)

    def gateway_source(self, root):
        (root / 'LICENSE').write_text('Fixture project license')
        (root / 'scripts').mkdir(); (root / 'scripts/node-runtime.json').write_text('{"version":"v24.21.0"}')
        fonts = root / 'packages/gateway-console/public/fonts'; fonts.mkdir(parents=True)
        for family in ['Geist','Geist-Mono','Bricolage-Grotesque']: (fonts / (family+'-OFL.txt')).write_text('Fixture OFL text')
        for name in ['react','react-dom','scheduler','qrcode-generator','vite','@vitejs/plugin-react','ws','zod']:
            package = root / 'packages/gateway-console/node_modules' / name; package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'name':name,'version':'1.2.3','license':'MIT'}))
            (package / 'LICENSE').write_text('Fixture upstream license')
        archives=root/'archives'; archives.mkdir(); (archives/'node-LICENSE').write_text('Fixture Node complete license')
        return fonts, archives

    def test_gateway_requires_each_distributed_font_and_includes_node_license(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); fonts, archives=self.gateway_source(root)
            with patch.object(notices,'download',side_effect=AssertionError('no network')):
                result=notices.collect('gateway',root/'out',source=root,archives=archives)
                self.assertTrue(any(item['name']=='node' for item in result))
                self.assertTrue((root/'out/LICENSES/runtimes/node/LICENSE').exists())
                (fonts/'Geist-OFL.txt').unlink()
                with self.assertRaisesRegex(ValueError,'font notice'):
                    notices.collect('gateway',root/'bad',source=root,archives=archives)

    def test_each_engine_platform_requires_its_own_runtime_notice_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'source'; source.mkdir(); (source/'LICENSE').write_text('Fixture project license')
            for asset,target in merger.TARGETS.items():
                (root/(asset+'.NOTICES.txt')).write_text('Fixture notices')
                with tarfile.open(root/(asset+'.licenses.tgz'),'w:gz') as archive:
                    files={'LICENSES/platform.json':json.dumps({'target':target,'rustVersion':'1.96.0'}).encode(),
                           'LICENSES/inventory.json':b'[]','LICENSES/runtimes/rust/COPYRIGHT-library.html':b'Fixture Rust notice',
                           'LICENSES/runtimes/musl-COPYRIGHT.txt':b'Fixture musl notice'}
                    for name,data in files.items():
                        entry=tarfile.TarInfo(name); entry.size=len(data); archive.addfile(entry,io.BytesIO(data))
            merger.merge(root,source)
            with tarfile.open(root/'third-party-licenses.tgz') as archive:
                for asset in merger.TARGETS: self.assertIn(f'LICENSES/{asset}/platform.json',archive.getnames())
            (root/'engine-darwin-x64.NOTICES.txt').unlink()
            with self.assertRaisesRegex(ValueError,'platform notices'): merger.merge(root,source)


if __name__ == "__main__":
    unittest.main()

