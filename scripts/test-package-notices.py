import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_notices", Path(__file__).with_name("package-notices.py"))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


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


if __name__ == "__main__":
    unittest.main()
