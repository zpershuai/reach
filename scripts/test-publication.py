#!/usr/bin/env python3
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile


spec = importlib.util.spec_from_file_location("publication", Path(__file__).with_name("verify-publication.py"))
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="reach-publication-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        (self.root / "source").mkdir()
        (self.root / "source/LICENSE").write_text("fixture attribution")
        self.inventory = {
            "schemaVersion": 1,
            "scope": {kind: ["source"] if kind == "candidate" else [] for kind in publication.KINDS},
            "items": [{"id": "source", "kind": "candidate", "path": "source", "sha256": publication.tree_snapshot(self.root / "source")["sha256"]}],
        }

    def test_complete_bytes_never_imply_scanned_or_approved(self):
        report = publication.inspect_inventory(self.inventory, self.root)
        self.assertEqual(report["coverage"], "complete")
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["inventorySha256"], publication.json_digest(self.inventory))

    def test_missing_duplicate_and_unscoped_items_fail(self):
        for inventory in [
            {**self.inventory, "items": []},
            {**self.inventory, "items": self.inventory["items"] * 2},
            {**self.inventory, "scope": {"candidate": ["source"]}},
            {**self.inventory, "scope": {**self.inventory["scope"], "image": ["unlisted-image"]}},
        ]:
            with self.assertRaises(ValueError):
                publication.inspect_inventory(inventory, self.root)

    def test_changed_bytes_invalidate_coverage(self):
        (self.root / "source/LICENSE").write_text("changed fixture attribution")
        report = publication.inspect_inventory(self.inventory, self.root)
        self.assertEqual(report["coverage"], "incomplete")
        self.assertEqual(report["items"][0]["code"], "CONTENT_CHANGED")

    def test_timeout_and_missing_paths_remain_incomplete(self):
        for location in [{"url": "https://github.com/example/reach/releases/download/v1/asset"}, {"path": "missing"}]:
            inventory = copy.deepcopy(self.inventory)
            inventory["items"][0].pop("path")
            inventory["items"][0].update(location)
            with patch.object(publication, "download", side_effect=TimeoutError):
                report = publication.inspect_inventory(inventory, self.root)
            self.assertEqual(report["coverage"], "incomplete")
            self.assertEqual(report["items"][0]["code"], "ITEM_UNAVAILABLE")

    def test_unsafe_urls_and_redirect_credentials(self):
        for url in ["http://github.com/example/reach", "https://unapproved.example/asset", "https://user:password@github.com/asset", "file:///tmp/asset"]:
            with self.assertRaises(ValueError):
                publication.checked_url(url)
        publication.checked_url("http://127.0.0.1:12345/fixture", test_mode=True)
        request = publication.urllib.request.Request("https://api.github.com/fixture", headers={"Authorization": "fixture", "Cookie": "fixture"})
        redirected = publication.CheckedRedirect().redirect_request(request, None, 302, "fixture", {}, "https://release-assets.githubusercontent.com/fixture")
        self.assertFalse(redirected.has_header("Authorization"))
        self.assertFalse(redirected.has_header("Cookie"))

    def test_reports_are_private_and_not_allowed_in_tracked_source(self):
        repository = Path(__file__).resolve().parent.parent
        with self.assertRaises(ValueError):
            publication.write_private_report(repository / "report.json", {}, repository)
        path = self.root / "private/report.json"
        publication.write_private_report(path, {"status": "incomplete"}, repository)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(path.read_text())["status"], "incomplete")
        link = self.root / "linked"
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            publication.write_private_report(link, {}, repository)


def tar_bytes(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    return output.getvalue()


class ScannerTests(unittest.TestCase):
    def setUp(self):
        PublicationTests.setUp(self)
        self.scanner = publication.scanner_binary()
        self.secret = b"REACH_TEST_" + b"SECRET=" + b"A1B2C3D4" * 4

    def asset_inventory(self, content, kind="release-asset", asset_format="archive"):
        (self.root / "asset").write_bytes(content)
        return {
            "schemaVersion": 1,
            "scope": {key: ["asset"] if key == kind else [] for key in publication.KINDS},
            "items": [{"id": "asset", "kind": kind, "path": "asset", "format": asset_format, "sha256": publication.sha256(content)}],
        }

    def scan(self, inventory=None):
        return publication.scan_inventory(inventory or self.inventory, self.root, self.scanner)

    def test_pinned_version_is_required(self):
        result = subprocess.CompletedProcess([], 0, stdout="0.0.0\n", stderr="")
        with patch.object(publication.subprocess, "run", return_value=result):
            with self.assertRaises(ValueError):
                publication.scanner_binary(self.scanner)

    def test_clean_tree_needs_digest_bound_human_review(self):
        item = self.inventory["items"][0]
        item["review"] = {"status": "approved", "sha256": item["sha256"], "reviewer": "fixture-reviewer", "reviewedAt": "2026-10-21T00:00:00Z"}
        result = self.scan()["items"][0]
        self.assertEqual(result["status"], "scanned")
        self.assertEqual(result["humanReview"], "approved")
        item["review"]["sha256"] = "0" * 64
        self.assertEqual(self.scan()["items"][0]["humanReview"], "required")

    def test_secret_is_redacted_and_inline_allow_cannot_hide_it(self):
        (self.root / "source/fixture.txt").write_bytes(self.secret + b" # gitleaks:allow\n")
        self.inventory["items"][0]["sha256"] = publication.tree_snapshot(self.root / "source")["sha256"]
        report = self.scan()
        self.assertEqual(report["items"][0]["status"], "findings")
        self.assertNotIn(self.secret.decode().split("=")[1], json.dumps(report))

    def test_nested_release_archives_are_scanned(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, mode="w") as archive:
            archive.writestr("nested.tar", tar_bytes({"fixture.txt": self.secret}))
        self.assertEqual(self.scan(self.asset_inventory(output.getvalue()))["items"][0]["status"], "findings")
        self.assertEqual(self.scan(self.asset_inventory(output.getvalue(), asset_format="file"))["items"][0]["status"], "findings")

    def test_docker_deleted_secret_remains_visible_in_original_layer(self):
        first = tar_bytes({"fixture.txt": self.secret})
        second = tar_bytes({".wh.fixture.txt": b""})
        manifest = [{"Config": "config.json", "RepoTags": ["example/reach:fixture"], "Layers": ["first/layer.tar", "second/layer.tar"]}]
        content = tar_bytes({"manifest.json": json.dumps(manifest).encode(), "config.json": b"{}", "first/layer.tar": first, "second/layer.tar": second})
        item = self.scan(self.asset_inventory(content, kind="image"))["items"][0]
        self.assertEqual(item["status"], "findings")
        self.assertEqual([layer["sha256"] for layer in item["layers"]], [publication.sha256(first), publication.sha256(second)])

    def test_missing_image_layer_is_incomplete(self):
        manifest = [{"Config": "config.json", "Layers": ["missing/layer.tar"]}]
        content = tar_bytes({"manifest.json": json.dumps(manifest).encode(), "config.json": b"{}"})
        report = self.scan(self.asset_inventory(content, kind="image"))
        self.assertEqual(report["coverage"], "incomplete")
        self.assertEqual(report["items"][0]["code"], "SCAN_INCOMPLETE")

    def test_oci_layer_descriptor_bytes_are_verified(self):
        layer = tar_bytes({"fixture.txt": self.secret})
        def descriptor(data, media):
            return {"mediaType": media, "size": len(data), "digest": "sha256:" + publication.sha256(data)}
        config = b"{}"
        layer_descriptor = descriptor(layer, "application/vnd.oci.image.layer.v1.tar")
        manifest = json.dumps({"config": descriptor(config, "application/vnd.oci.image.config.v1+json"), "layers": [layer_descriptor]}).encode()
        index = {"manifests": [descriptor(manifest, "application/vnd.oci.image.manifest.v1+json")]}
        files = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}', "index.json": json.dumps(index).encode()}
        for data in [layer, config, manifest]:
            files["blobs/sha256/" + publication.sha256(data)] = data
        report = self.scan(self.asset_inventory(tar_bytes(files), kind="image"))
        self.assertEqual(report["items"][0]["status"], "findings")
        files["blobs/sha256/" + publication.sha256(layer)] = b"changed"
        self.assertEqual(self.scan(self.asset_inventory(tar_bytes(files), kind="image"))["coverage"], "incomplete")

    def test_git_history_and_annotated_tag_messages_are_scanned(self):
        repo = self.root / "repository"
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(["git", "-C", str(repo), *args], text=True)
        git("init", "-q")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        path = repo / "fixture.txt"
        path.write_bytes(self.secret)
        git("add", ".")
        git("commit", "-qm", "fixture with a synthetic secret")
        path.write_text("removed from final tree")
        git("add", ".")
        git("commit", "-qm", "fixture removal")
        git("tag", "-a", "fixture-tag", "-m", "fixture tag message")
        revision, objects = publication.git_objects(repo, "fixture-tag")
        inventory = {"schemaVersion": 1, "scope": {key: ["ref"] if key == "git-ref" else [] for key in publication.KINDS}, "items": [{"id": "ref", "kind": "git-ref", "path": "repository", "revision": "fixture-tag", "sha256": publication.git_digest(revision, objects)}]}
        self.assertEqual(self.scan(inventory)["items"][0]["status"], "findings")
        git("tag", "-fa", "fixture-tag", "-m", "different tag message")
        self.assertEqual(self.scan(inventory)["items"][0]["code"], "CONTENT_CHANGED")

    def test_archive_escape_is_not_extracted(self):
        report = self.scan(self.asset_inventory(tar_bytes({"../outside.txt": b"fixture"})))
        self.assertEqual(report["coverage"], "incomplete")
        self.assertFalse((self.root / "outside.txt").exists())


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        PublicationTests.setUp(self)
        self.scanner = publication.scanner_binary()

    def review(self, digest, key="scopeSha256"):
        return {"status": "approved", key: digest, "reviewer": "fixture-reviewer", "reviewedAt": "2020-01-01T00:00:00Z"}

    def evidence(self, gate, digest):
        path = self.root / f"{gate}-evidence.json"
        payload = {"status": "passed", "scopeSha256": digest, "checks": {check: "passed" for check in publication.REQUIRED_CHECKS[gate]}}
        path.write_text(json.dumps(payload))
        return {"path": path.name, "sha256": publication.sha256(path.read_bytes())}

    def approved_inventory(self):
        inventory = copy.deepcopy(self.inventory)
        digest = publication.plan_digest(inventory)
        inventory["scopeReview"] = {**self.review(digest), "omittedReasons": {kind: "Fixture publishes source only" for kind, ids in inventory["scope"].items() if not ids}}
        inventory["credentialReview"] = {**self.review(digest), "incidents": []}
        inventory["legacyReview"] = {**self.review(digest), "clients": []}
        inventory["gates"] = {gate: self.evidence(gate, digest) for gate in ["security", "release"]}
        inventory["items"][0]["review"] = self.review(inventory["items"][0]["sha256"], "sha256")
        return inventory

    def assess(self, inventory):
        report = publication.scan_inventory(inventory, self.root, self.scanner)
        return publication.assess_readiness(inventory, report, self.root)

    def test_passing_gate_is_still_not_a_publication_claim(self):
        report = self.assess(self.approved_inventory())
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["blockers"], [])
        self.assertFalse(report["published"])

    def test_missing_reviews_and_p0_checks_are_blockers(self):
        for field, code in [("scopeReview", "SCOPE_REVIEW_REQUIRED"), ("credentialReview", "CREDENTIAL_REVIEW_REQUIRED"), ("legacyReview", "LEGACY_REVIEW_REQUIRED"), ("gates", "SECURITY_EVIDENCE_REQUIRED")]:
            inventory = self.approved_inventory()
            inventory.pop(field)
            report = self.assess(inventory)
            self.assertIn(code, report["blockers"])
            self.assertEqual(report["status"], "incomplete")

    def test_removed_secret_still_needs_credential_invalidation(self):
        inventory = self.approved_inventory()
        inventory["credentialReview"]["incidents"] = [{"id": "synthetic-credential", "status": "removed-from-source"}]
        self.assertIn("CREDENTIAL_DISPOSITION_REQUIRED", self.assess(inventory)["blockers"])
        incident = inventory["credentialReview"]["incidents"][0]
        incident.update(status="revoked", evidence=self.evidence("credential-disposition", publication.plan_digest(inventory)))
        self.assertEqual(self.assess(inventory)["status"], "passed")

    def test_legacy_review_must_be_explicit_for_each_client(self):
        inventory = self.approved_inventory()
        inventory["legacyReview"]["clients"] = [{"id": "legacy-fixture", "authority": "global", "status": "pending"}]
        self.assertIn("LEGACY_REVIEW_REQUIRED", self.assess(inventory)["blockers"])
        inventory["legacyReview"]["clients"] = [{"id": "legacy-fixture", "authority": "owner-approved-global", **self.review(publication.plan_digest(inventory))}]
        self.assertEqual(self.assess(inventory)["status"], "passed")

    def test_candidate_change_and_reused_scan_cannot_pass(self):
        inventory = self.approved_inventory()
        report = publication.scan_inventory(inventory, self.root, self.scanner)
        changed = copy.deepcopy(inventory)
        changed["items"][0]["sha256"] = "a" * 64
        report = publication.assess_readiness(changed, report, self.root)
        self.assertIn("INVENTORY_CHANGED", report["blockers"])
        self.assertIn("ITEM_NOT_SCANNED", report["blockers"])
        self.assertIn("SECURITY_EVIDENCE_REQUIRED", report["blockers"])

    def test_tampered_evidence_and_omitted_p0_check_fail(self):
        inventory = self.approved_inventory()
        path = self.root / inventory["gates"]["security"]["path"]
        evidence = json.loads(path.read_text())
        evidence["checks"].pop("cross-principal")
        path.write_text(json.dumps(evidence))
        self.assertIn("SECURITY_EVIDENCE_REQUIRED", self.assess(inventory)["blockers"])
        inventory["gates"]["security"]["sha256"] = publication.sha256(path.read_bytes())
        self.assertIn("SECURITY_EVIDENCE_REQUIRED", self.assess(inventory)["blockers"])

    def test_findings_need_digest_bound_non_secret_exceptions(self):
        path = self.root / "source/fixture.txt"
        path.write_bytes(b"REACH_TEST_" + b"SECRET=" + b"A1B2C3D4" * 4)
        self.inventory["items"][0]["sha256"] = publication.tree_snapshot(self.root / "source")["sha256"]
        inventory = self.approved_inventory()
        report = self.assess(inventory)
        self.assertIn("UNRESOLVED_FINDINGS", report["blockers"])
        fingerprint = report["items"][0]["findings"][0]["Fingerprint"]
        exception = {"fingerprint": fingerprint, "kind": "non-secret", "reason": "Isolated synthetic regression marker"}
        inventory["items"][0]["review"]["exceptions"] = [exception]
        self.assertEqual(self.assess(inventory)["status"], "passed")
        exception["kind"] = "valid-credential"
        self.assertIn("INVALID_EXCEPTION", self.assess(inventory)["blockers"])

    def test_incomplete_scan_cannot_be_waived(self):
        inventory = self.approved_inventory()
        (self.root / "source").rename(self.root / "missing-source")
        report = self.assess(inventory)
        self.assertIn("SCAN_COVERAGE_INCOMPLETE", report["blockers"])
        self.assertEqual(report["status"], "incomplete")


class ScannerInstallTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("install_publication_tools", Path(__file__).with_name("install-publication-tools.py"))
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)
        directory = tempfile.TemporaryDirectory(prefix="reach-scanner-install-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()

    def test_corrupt_package_preserves_existing_scanner(self):
        destination = self.root / "tools"
        destination.mkdir()
        (destination / "gitleaks").write_bytes(b"previous fixture scanner")
        archive = self.root / "package.tar.gz"
        archive.write_bytes(b"corrupt package")
        with self.assertRaises(ValueError):
            self.installer.install(destination, archive)
        self.assertEqual((destination / "gitleaks").read_bytes(), b"previous fixture scanner")

    def fixture_archive(self):
        payload = b"fixture scanner"
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as package:
            entry = tarfile.TarInfo("gitleaks"); entry.size = len(payload)
            package.addfile(entry, io.BytesIO(payload))
        return data.getvalue(), payload

    def test_verified_cached_archive_is_reused_and_a_tampered_one_is_not(self):
        import platform
        content, payload = self.fixture_archive()
        system = platform.system().lower()
        architecture = {"x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}[platform.machine()]
        target = f"{system}_{architecture}"
        pin = dict(self.installer.PIN, sha256={target: hashlib.sha256(content).hexdigest()})
        destination = self.root / "tools"
        destination.mkdir()
        cached = destination / f"gitleaks_{pin['version']}_{target}.tar.gz"
        cached.write_bytes(content)
        def offline(url):
            raise self.installer.ScannerInstallError("Scanner download failed after 3 attempts; check network access to github.com")
        with patch.object(self.installer, "PIN", pin), patch.object(self.installer, "download", offline):
            self.assertEqual(self.installer.install(destination).read_bytes(), payload)
            cached.write_bytes(content + b"tampered")
            (destination / "gitleaks").write_bytes(b"previous fixture scanner")
            with self.assertRaisesRegex(self.installer.ScannerInstallError, "download failed"):
                self.installer.install(destination)
        self.assertEqual((destination / "gitleaks").read_bytes(), b"previous fixture scanner")

    def test_scanner_download_refuses_insecure_or_unapproved_redirect(self):
        request = publication.urllib.request.Request("https://github.com/gitleaks/gitleaks/fixture")
        for target in ["http://github.com/fixture", "https://unapproved.example/fixture"]:
            with self.assertRaises(ValueError):
                self.installer.ScannerRedirect().redirect_request(request, None, 302, "fixture", {}, target)


if __name__ == "__main__":
    unittest.main()
