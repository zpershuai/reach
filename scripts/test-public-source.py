#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("public_source", Path(__file__).with_name("prepare-public-source.py"))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class SourceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="reach-public-source-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.files = {
            "LICENSE": "Fixture attribution\n", "NOTICE": "Required attribution\n",
            "src/main.rs": "committed source", "scripts/run.sh": "#!/bin/sh\nexit 0\n",
            ".reach/inventory.json": "private fixture", "deploy/gateway.env": "private fixture",
            "deploy/engines.json": "private fixture", "deploy/data/reach.db": "private fixture",
            "packages/demo/node_modules/dependency/index.js": "generated",
            "packages/demo/dist/main.js": "generated", "target/binary": "generated",
            ".env": "private fixture", "run.log": "private fixture",
            "deploy/engines.json.example": "reserved example",
        }
        for name, content in self.files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        (self.repo / "scripts/run.sh").chmod(0o755)
        self.git("add", ".")
        self.git("commit", "-qm", "fixture source")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.output = self.root / "candidate"

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def test_committed_snapshot_excludes_private_state_and_preserves_source(self):
        (self.repo / "src/main.rs").write_text("uncommitted source")
        (self.repo / "untracked.txt").write_text("not approved")
        before = self.git("status", "--porcelain"), self.git("show-ref")
        report = source.export_source(self.repo, self.commit, self.output)
        self.assertEqual((self.output / "src/main.rs").read_text(), "committed source")
        self.assertEqual({item["path"] for item in report["files"]}, {"LICENSE", "NOTICE", "src/main.rs", "scripts/run.sh", "deploy/engines.json.example"})
        self.assertFalse((self.output / ".git").exists())
        self.assertEqual((self.output / "scripts/run.sh").stat().st_mode & 0o777, 0o755)
        self.assertEqual(before, (self.git("status", "--porcelain"), self.git("show-ref")))

    def test_nonempty_and_symlink_targets_are_not_overwritten(self):
        self.output.mkdir()
        kept = self.output / "keep.txt"
        kept.write_text("keep")
        with self.assertRaises(ValueError):
            source.export_source(self.repo, self.commit, self.output)
        self.assertEqual(kept.read_text(), "keep")
        link = self.root / "linked"
        link.symlink_to(self.output, target_is_directory=True)
        with self.assertRaises(ValueError):
            source.export_source(self.repo, self.commit, link)

    def test_committed_symlinks_fail_without_partial_export(self):
        (self.repo / "escape").symlink_to("../outside")
        self.git("add", "escape")
        self.git("commit", "-qm", "fixture symlink")
        with self.assertRaises(ValueError):
            source.export_source(self.repo, "HEAD", self.output)
        self.assertFalse(self.output.exists())

    def test_allowlist_cannot_remove_attribution_or_include_private_files(self):
        for include in [{"src/main.rs"}, {"LICENSE", "src/main.rs"}, {"LICENSE", "NOTICE", ".reach/inventory.json"}]:
            with self.assertRaises(ValueError):
                source.export_source(self.repo, self.commit, self.output, include)
        report = source.export_source(self.repo, self.commit, self.output, {"LICENSE", "NOTICE", "src/main.rs"})
        self.assertEqual(len(report["files"]), 3)

    def test_invalid_revision_does_not_create_output(self):
        with self.assertRaises(ValueError):
            source.export_source(self.repo, "missing-commit", self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
