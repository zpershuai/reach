#!/usr/bin/env python3
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("release_metadata", Path(__file__).with_name("release-metadata.py"))
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class ReleaseTests(unittest.TestCase):
    def test_tag_version_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "packages/reach-rpc").mkdir(parents=True)
            (root / "packages/reach-rpc/package.json").write_text(json.dumps({"version": "0.3.1"}))
            self.assertEqual(metadata.parse_tag("gateway-v0.3.1", root), ("gateway", "0.3.1"))
            for tag in ["gateway-v0.3.2", "gateway-v00.3.1", "gateway-v0.3.1-rc.1", "arbitrary"]:
                with self.assertRaises(ValueError):
                    metadata.parse_tag(tag, root)

    def test_required_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                metadata.checksums(root, ["engine-darwin-x64"])
            (root / "engine-darwin-x64").write_bytes(b"fixture")
            metadata.checksums(root, ["engine-darwin-x64"])
            self.assertIn("engine-darwin-x64", (root / "SHA256SUMS").read_text())

    def test_notes_use_component_range_and_filter_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], text=True)
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (root / "packages/reach-rpc").mkdir(parents=True)
            manifest = root / "packages/reach-rpc/package.json"
            manifest.write_text(json.dumps({"version": "0.3.0"}))
            git("add", ".")
            git("commit", "-qm", "old component change")
            git("tag", "gateway-v0.3.0")
            manifest.write_text(json.dumps({"version": "0.3.1"}))
            git("add", ".")
            git("commit", "-qm", "fix: retain useful commit", "-m", "ssh fixture@host.example.invalid\n.reach/inventory\ngateway.env credentials\nUseful public detail")
            git("tag", "engine-v0.2.1")
            git("tag", "gateway-v0.3.1")
            notes = metadata.release_notes("gateway-v0.3.1", root)
            self.assertIn("retain useful commit", notes)
            self.assertIn("Useful public detail", notes)
            self.assertNotIn("old component change", notes)
            for private in ["fixture@", ".reach/", "gateway.env"]:
                self.assertNotIn(private, notes)


if __name__ == "__main__":
    unittest.main()
