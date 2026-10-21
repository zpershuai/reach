#!/usr/bin/env python3
"""Inspect a private publication inventory; incomplete coverage never passes."""

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile


KINDS = {"candidate", "git-ref", "release-asset", "image", "build-context"}
APPROVED_HOSTS = {"api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "ghcr.io"}
MAX_DOWNLOAD = 512 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
MAX_FILES = 100_000
TOOLS = json.loads(Path(__file__).with_name("publication-tools.json").read_text())
PROJECT = Path(__file__).resolve().parent.parent
REQUIRED_CHECKS = {
    "security": {"unauthenticated", "expiry", "revocation", "cross-principal", "cross-engine", "cross-workspace", "read-only", "workspace-containment", "process-opt-in", "restricted-execution", "tls", "log-redaction", "package-integrity", "recovery"},
    "release": {"licenses", "source-provenance", "platforms", "checksums", "workflow-isolation"},
    "credential-disposition": {"credential-invalidated"},
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_digest(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def plan_digest(inventory):
    items = [{key: value for key, value in item.items() if key != "review"} for item in inventory["items"]]
    return json_digest({"scope": inventory["scope"], "items": items})


def valid_digest(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def validate_inventory(inventory):
    if not isinstance(inventory, dict) or inventory.get("schemaVersion") != 1:
        raise ValueError("Inventory schemaVersion must be 1")
    scope = inventory.get("scope")
    items = inventory.get("items")
    if not isinstance(scope, dict) or set(scope) != KINDS or not isinstance(items, list):
        raise ValueError("Inventory must enumerate every publication surface category")
    expected = []
    for kind, ids in scope.items():
        if not isinstance(ids, list) or any(not isinstance(item, str) or not item for item in ids):
            raise ValueError("Scope must contain lists of nonempty item IDs")
        expected.extend(ids)
    if not expected or len(expected) != len(set(expected)):
        raise ValueError("Publication scope must be nonempty and have unique IDs")
    actual = []
    for item in items:
        if not isinstance(item, dict) or item.get("kind") not in KINDS:
            raise ValueError("Invalid inventory item")
        item_id = item.get("id")
        if not isinstance(item_id, str) or item_id not in scope[item["kind"]]:
            raise ValueError("Item is missing from its declared scope")
        if not valid_digest(item.get("sha256")):
            raise ValueError("Every item needs an expected SHA-256")
        if ("path" in item) == ("url" in item):
            raise ValueError("Every item must select exactly one local path or URL")
        location = item.get("path", item.get("url"))
        if not isinstance(location, str) or not location:
            raise ValueError("Every item needs a nonempty location string")
        if item["kind"] == "git-ref" and not item.get("revision"):
            raise ValueError("A published Git reference needs its exact revision")
        actual.append(item_id)
    if len(actual) != len(set(actual)) or set(expected) != set(actual):
        raise ValueError("Declared scope and item coverage differ")
    return inventory


def tree_snapshot(root):
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("Source trees must be real directories")
    files = []
    for path in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ValueError("Source trees must not contain symlinks or special files")
        files.append({"path": path.relative_to(root).as_posix(), "mode": "100755" if mode & 0o111 else "100644", "sha256": sha256(path.read_bytes())})
    return {"sha256": json_digest(files), "files": files}


def git_objects(repository, revision):
    def read(*args):
        process = subprocess.run(["git", "-C", str(repository), *args], capture_output=True, timeout=60)
        if process.returncode:
            raise ValueError("Unable to read publication reference")
        return process.stdout
    root = read("rev-parse", "--verify", f"{revision}^{{object}}").decode().strip()
    ids = {line.split()[0].decode() for line in read("rev-list", "--objects", root).splitlines()}
    ids.add(root)  # Annotated tag objects are publication content too.
    if len(ids) > MAX_FILES:
        raise ValueError("Publication reference exceeds object budget")
    objects = []
    size = 0
    for oid in sorted(ids):
        kind = read("cat-file", "-t", oid).decode().strip()
        content = read("cat-file", "-p", oid)
        size += len(content)
        if size > MAX_EXPANDED:
            raise ValueError("Publication reference exceeds byte budget")
        objects.append({"oid": oid, "type": kind, "content": content})
    return root, objects


def git_digest(root, objects):
    return json_digest({"revision": root, "objects": [{"oid": item["oid"], "type": item["type"], "sha256": sha256(item["content"])} for item in objects]})


def checked_url(url, test_mode=False):
    parsed = urllib.parse.urlsplit(url)
    local_test = test_mode and parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1"}
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Release URL contains unsafe authority or fragment")
    if not local_test and (parsed.scheme != "https" or parsed.hostname not in APPROVED_HOSTS or parsed.port not in {None, 443}):
        raise ValueError("Release URL is not an approved HTTPS origin")
    return url


class CheckedRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, test_mode=False):
        super().__init__()
        self.test_mode = test_mode

    def redirect_request(self, request, fp, code, message, headers, new_url):
        checked_url(new_url, self.test_mode)
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if redirected:
            redirected.remove_header("Authorization")
            redirected.remove_header("Cookie")
        return redirected


def download(url, test_mode=False):
    opener = urllib.request.build_opener(CheckedRedirect(test_mode))
    request = urllib.request.Request(checked_url(url, test_mode), headers={"User-Agent": "reach-publication-verifier/1"})
    with opener.open(request, timeout=30) as response:
        data = response.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise ValueError("Publication download exceeds limit")
    return data


def inspect_item(item, base, test_mode=False):
    result = {"id": item["id"], "kind": item["kind"], "expectedSha256": item["sha256"], "status": "incomplete"}
    try:
        if "url" in item:
            observed = sha256(download(item["url"], test_mode))
        elif item["kind"] == "git-ref":
            revision, objects = git_objects(base / item["path"], item["revision"])
            result["revision"] = revision
            observed = git_digest(revision, objects)
        else:
            path = base / item["path"]
            if path.is_symlink():
                raise ValueError("Publication item cannot be a symlink")
            if path.is_dir():
                observed = tree_snapshot(path)["sha256"]
            elif path.is_file():
                observed = sha256(path.read_bytes())
            else:
                raise ValueError("Publication item is unavailable")
        result["sha256"] = observed
        result["status"] = "ready" if observed == item["sha256"] else "incomplete"
        if result["status"] != "ready":
            result["code"] = "CONTENT_CHANGED"
    except (OSError, ValueError, TimeoutError, subprocess.SubprocessError, urllib.error.URLError):
        result["code"] = "ITEM_UNAVAILABLE"
    return result


def inspect_inventory(inventory, base, test_mode=False):
    validate_inventory(inventory)
    items = [inspect_item(item, Path(base), test_mode) for item in inventory["items"]]
    return {
        "schemaVersion": 1, "checkedAt": datetime.now(timezone.utc).isoformat(),
        "inventorySha256": json_digest(inventory), "items": items,
        "coverage": "complete" if all(item["status"] == "ready" for item in items) else "incomplete",
        "status": "incomplete", "code": "SCANNING_AND_REVIEW_REQUIRED",
    }


def scanner_binary(path=None):
    version = TOOLS["gitleaks"]["version"]
    selected = path or os.environ.get("REACH_GITLEAKS_BIN") or shutil.which("gitleaks")
    if not selected:
        selected = PROJECT / f".reach/tools/gitleaks-{version}/gitleaks"
    binary = Path(selected).resolve()
    process = subprocess.run([str(binary), "version"], capture_output=True, text=True, timeout=15)
    if process.returncode or process.stdout.strip().removeprefix("v") != version:
        raise ValueError("Install the pinned Gitleaks version")
    return binary


def archive_entries(content):
    if zipfile.is_zipfile(io.BytesIO(content)):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            for entry in archive.infolist():
                if not entry.is_dir():
                    if entry.file_size > MAX_EXPANDED:
                        raise ValueError("Archive member exceeds byte budget")
                    yield entry.filename, archive.read(entry), stat.S_ISLNK(entry.external_attr >> 16)
        return
    try:
        archive = tarfile.open(fileobj=io.BytesIO(content), mode="r:*")
    except tarfile.ReadError as error:
        raise ValueError("Unsupported publication archive") from error
    with archive:
        for entry in archive:
            if entry.size > MAX_EXPANDED:
                raise ValueError("Archive member exceeds byte budget")
            if entry.isfile():
                yield entry.name, archive.extractfile(entry).read(), False
            elif not entry.isdir():
                # Scan metadata without materializing symlinks, devices or FIFOs.
                yield entry.name, entry.linkname.encode(), True


def safe_member(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\0" in name:
        raise ValueError("Unsafe archive member")
    return path


def is_archive(content):
    if zipfile.is_zipfile(io.BytesIO(content)):
        return True
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:*"):
            return True
    except tarfile.ReadError:
        return False


def materialize_archive(content, destination, budget, depth=0):
    if depth > 5:
        raise ValueError("Nested archive depth exceeds limit")
    seen = set()
    for name, data, metadata_only in archive_entries(content):
        path = safe_member(name)
        if str(path) in seen:
            raise ValueError("Duplicate archive member")
        seen.add(str(path))
        budget[0] += len(data)
        budget[1] += 1
        if budget[0] > MAX_EXPANDED or budget[1] > MAX_FILES:
            raise ValueError("Archive expansion exceeds budget")
        target = destination / f"entry-{budget[1]}"
        target.mkdir(parents=True)
        (target / "name.txt").write_text(name)
        (target / "content").write_bytes(data)
        if not metadata_only and (name.endswith((".tar", ".tar.gz", ".tgz", ".zip")) or is_archive(data)):
            materialize_archive(data, target / "expanded", budget, depth + 1)


def image_layers(content):
    entries = {}
    size = 0
    for name, data, metadata_only in archive_entries(content):
        key = str(safe_member(name))
        if key in entries or metadata_only:
            raise ValueError("Unsupported or duplicate image archive entry")
        size += len(data)
        if size > MAX_EXPANDED or len(entries) >= MAX_FILES:
            raise ValueError("Image archive exceeds budget")
        entries[key] = data
    layers = []
    if "manifest.json" in entries:
        manifests = json.loads(entries["manifest.json"])
        if not isinstance(manifests, list) or not manifests:
            raise ValueError("Image archive has no manifests")
        for manifest in manifests:
            if manifest["Config"] not in entries:
                raise ValueError("Image config is missing")
            for name in manifest["Layers"]:
                data = entries[str(safe_member(name))]
                layers.append({"name": name, "sha256": sha256(data), "content": data})
    elif "index.json" in entries and "oci-layout" in entries:
        visited = set()
        def descriptor(item, depth=0):
            if depth > 8:
                raise ValueError("OCI manifest nesting exceeds limit")
            algorithm, digest = item["digest"].split(":", 1)
            if algorithm != "sha256" or not valid_digest(digest):
                raise ValueError("Unsupported OCI digest")
            data = entries[f"blobs/sha256/{digest}"]
            if sha256(data) != digest or len(data) != item["size"]:
                raise ValueError("OCI descriptor does not match its bytes")
            if digest in visited:
                return
            visited.add(digest)
            media = item["mediaType"]
            if "layer" in media:
                layers.append({"name": item["digest"], "sha256": digest, "content": data})
            elif "manifest" in media or "index" in media:
                manifest = json.loads(data)
                for child in manifest.get("manifests", []) + manifest.get("layers", []):
                    descriptor(child, depth + 1)
                if "config" in manifest:
                    descriptor(manifest["config"], depth + 1)
            elif "image.config" not in media and "container.image" not in media:
                raise ValueError("Unsupported OCI media type")
        manifests = json.loads(entries["index.json"])["manifests"]
        if not manifests:
            raise ValueError("OCI index has no manifests")
        for item in manifests:
            descriptor(item)
    else:
        raise ValueError("Image archive must be Docker-save or OCI format")
    return entries, layers


def materialize_item(item, base, destination, test_mode=False):
    destination.mkdir()
    if item["kind"] == "git-ref":
        root, objects = git_objects(base / item["path"], item["revision"])
        if git_digest(root, objects) != item["sha256"]:
            raise ValueError("Publication reference changed")
        for record in objects:
            (destination / record["oid"]).write_bytes(record["content"])
        return {}
    path = base / item["path"] if "path" in item else None
    if path and path.is_dir():
        snapshot = tree_snapshot(path)
        if snapshot["sha256"] != item["sha256"]:
            raise ValueError("Publication tree changed")
        for record in snapshot["files"]:
            source = path / record["path"]
            content = source.read_bytes()
            if source.is_symlink() or sha256(content) != record["sha256"]:
                raise ValueError("Publication file changed while reading")
            target = destination / record["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        if tree_snapshot(path)["sha256"] != item["sha256"]:
            raise ValueError("Publication tree changed while reading")
        return {}
    content = download(item["url"], test_mode) if "url" in item else path.read_bytes()
    if sha256(content) != item["sha256"]:
        raise ValueError("Publication asset changed")
    (destination / "asset").write_bytes(content)
    if item["kind"] == "image":
        entries, layers = image_layers(content)
        for index, layer in enumerate(layers):
            materialize_archive(layer["content"], destination / f"layer-{index}", [0, 0])
        for index, (name, data) in enumerate(entries.items()):
            (destination / f"image-entry-{index}").write_bytes(name.encode() + b"\n" + data)
        return {"layers": [{"name": item["name"], "sha256": item["sha256"]} for item in layers]}
    asset_format = item.get("format", "file")
    if asset_format == "archive" or is_archive(content):
        materialize_archive(content, destination / "expanded", [0, 0])
    elif asset_format != "file":
        raise ValueError("Unsupported publication asset format")
    return {}


def scan_inventory(inventory, base, scanner=None, test_mode=False):
    report = inspect_inventory(inventory, base, test_mode)
    binary = scanner_binary(scanner)
    report["scanner"] = {"name": "gitleaks", "version": TOOLS["gitleaks"]["version"]}
    for item, result in zip(inventory["items"], report["items"]):
        if result["status"] != "ready":
            continue
        try:
            with tempfile.TemporaryDirectory(prefix="reach-publication-scan-") as directory:
                root = Path(directory).resolve()
                result.update(materialize_item(item, Path(base), root / "payload", test_mode))
                findings_path = root / "findings.json"
                ignore = root / "empty-ignore"
                ignore.touch()
                process = subprocess.run([str(binary), "dir", str(root / "payload"), "--config", str(PROJECT / ".gitleaks.toml"), "--no-banner", "--redact", "--report-format", "json", "--report-path", str(findings_path), "--exit-code", "10", "--max-decode-depth", "3", "--max-archive-depth", "6", "--ignore-gitleaks-allow", "--gitleaks-ignore-path", str(ignore)], capture_output=True, timeout=120)
                if process.returncode not in {0, 10}:
                    raise ValueError("Secret scanner could not complete")
                findings = json.loads(findings_path.read_text()) if findings_path.exists() else []
                if not isinstance(findings, list) or process.returncode == 10 and not findings:
                    raise ValueError("Invalid scanner report")
                for finding in findings:
                    file = str(finding["File"])
                    prefix = str(root / "payload") + "/"
                    if file.startswith(prefix):
                        file = file[len(prefix):]
                    finding["File"] = file
                    finding["Fingerprint"] = f"{item['id']}:{file}:{finding['RuleID']}:{finding['StartLine']}:{finding.get('StartColumn', 0)}"
                result["findings"] = findings
                result["status"] = "findings" if findings else "scanned"
                review = item.get("review", {})
                result["humanReview"] = "approved" if review.get("status") == "approved" and review.get("sha256") == result["sha256"] and review.get("reviewer") and review.get("reviewedAt") else "required"
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile, tarfile.TarError, subprocess.SubprocessError, urllib.error.URLError):
            result["status"] = "incomplete"
            result["code"] = "SCAN_INCOMPLETE"
    report["coverage"] = "complete" if all(item["status"] in {"scanned", "findings"} for item in report["items"]) else "incomplete"
    report["scanner"]["configSha256"] = sha256((PROJECT / ".gitleaks.toml").read_bytes())
    return report


def reviewed(record, digest, key="scopeSha256"):
    if not isinstance(record, dict) or record.get("status") != "approved" or record.get(key) != digest:
        return False
    if not isinstance(record.get("reviewer"), str) or not record["reviewer"].strip():
        return False
    try:
        date = datetime.fromisoformat(record["reviewedAt"].replace("Z", "+00:00"))
        return date.tzinfo is not None and date <= datetime.now(timezone.utc)
    except (ValueError, TypeError, KeyError, AttributeError):
        return False


def evidence_passed(reference, base, digest, gate):
    if not isinstance(reference, dict) or not valid_digest(reference.get("sha256")):
        return False
    try:
        path = (Path(base) / reference["path"]).absolute()
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
            return False
        if path.is_relative_to(PROJECT) and not path.is_relative_to(PROJECT / ".reach"):
            return False
        content = path.read_bytes()
        if sha256(content) != reference["sha256"]:
            return False
        evidence = json.loads(content)
        checks = evidence["checks"]
        return (
            evidence.get("status") == "passed"
            and evidence.get("scopeSha256") == digest
            and isinstance(checks, dict)
            and REQUIRED_CHECKS[gate].issubset(checks)
            and all(value == "passed" for value in checks.values())
        )
    except (OSError, ValueError, TypeError, KeyError):
        return False


def assess_readiness(inventory, report, base):
    validate_inventory(inventory)
    digest = plan_digest(inventory)
    report["scopeSha256"] = digest
    blockers = []
    if report.get("inventorySha256") != json_digest(inventory):
        blockers.append("INVENTORY_CHANGED")
    if report.get("coverage") != "complete":
        blockers.append("SCAN_COVERAGE_INCOMPLETE")
    scanner = report.get("scanner", {})
    if scanner.get("version") != TOOLS["gitleaks"]["version"] or scanner.get("configSha256") != sha256((PROJECT / ".gitleaks.toml").read_bytes()):
        blockers.append("SCANNER_EVIDENCE_INVALID")
    scope_review = inventory.get("scopeReview", {})
    if not reviewed(scope_review, digest):
        blockers.append("SCOPE_REVIEW_REQUIRED")
    omitted = scope_review.get("omittedReasons", {})
    if not isinstance(omitted, dict) or any(not omitted.get(kind) for kind, ids in inventory["scope"].items() if not ids):
        blockers.append("EMPTY_SCOPE_REASON_REQUIRED")
    results = {item["id"]: item for item in report.get("items", [])}
    if len(results) != len(inventory["items"]):
        blockers.append("RESULT_COVERAGE_INVALID")
    for item in inventory["items"]:
        result = results.get(item["id"], {})
        if result.get("status") not in {"scanned", "findings"} or result.get("sha256") != item["sha256"]:
            blockers.append("ITEM_NOT_SCANNED")
        review = item.get("review", {})
        if not reviewed(review, item["sha256"], "sha256"):
            blockers.append("ITEM_REVIEW_REQUIRED")
        exceptions = review.get("exceptions", [])
        findings = result.get("findings", [])
        fingerprints = {finding["Fingerprint"] for finding in findings}
        accepted = set()
        if not isinstance(exceptions, list):
            blockers.append("INVALID_EXCEPTION")
            exceptions = []
        for exception in exceptions:
            if not isinstance(exception, dict) or exception.get("kind") != "non-secret" or not exception.get("reason") or exception.get("fingerprint") not in fingerprints:
                blockers.append("INVALID_EXCEPTION")
            else:
                accepted.add(exception["fingerprint"])
        if fingerprints - accepted:
            blockers.append("UNRESOLVED_FINDINGS")
    credentials = inventory.get("credentialReview", {})
    if not reviewed(credentials, digest) or not isinstance(credentials.get("incidents"), list):
        blockers.append("CREDENTIAL_REVIEW_REQUIRED")
    else:
        for incident in credentials["incidents"]:
            if not isinstance(incident, dict) or incident.get("status") not in {"revoked", "rotated"} or not evidence_passed(incident.get("evidence"), base, digest, "credential-disposition"):
                blockers.append("CREDENTIAL_DISPOSITION_REQUIRED")
    legacy = inventory.get("legacyReview", {})
    if not reviewed(legacy, digest) or not isinstance(legacy.get("clients"), list):
        blockers.append("LEGACY_REVIEW_REQUIRED")
    else:
        for client in legacy["clients"]:
            if not isinstance(client, dict) or client.get("authority") not in {"scoped", "revoked", "owner-approved-global"} or not reviewed(client, digest):
                blockers.append("LEGACY_REVIEW_REQUIRED")
    gates = inventory.get("gates", {})
    for gate in ["security", "release"]:
        if not evidence_passed(gates.get(gate), base, digest, gate):
            blockers.append(f"{gate.upper()}_EVIDENCE_REQUIRED")
    report["blockers"] = sorted(set(blockers))
    report["status"] = "passed" if not blockers else "incomplete"
    report["code"] = "READY_FOR_PUBLICATION_REVIEW" if not blockers else "READINESS_INCOMPLETE"
    report["published"] = False
    return report


def write_private_report(path, report, repository):
    path = Path(path).absolute()
    repository = Path(repository).resolve()
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError("Private evidence path must not traverse symlinks")
    if path.is_relative_to(repository) and not path.is_relative_to(repository / ".reach"):
        raise ValueError("Evidence inside the repository must be under ignored .reach/")
    if path.is_relative_to(repository):
        check = subprocess.run(["git", "-C", str(repository), "check-ignore", "-q", str(path)], capture_output=True)
        if check.returncode:
            raise ValueError("Private evidence destination is not ignored")
        tracked = subprocess.run(["git", "-C", str(repository), "ls-files", "--error-unmatch", str(path)], capture_output=True)
        if not tracked.returncode:
            raise ValueError("Private evidence destination is tracked")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".publication-", delete=False) as output:
        temporary = Path(output.name)
        try:
            os.fchmod(output.fileno(), 0o600)
            json.dump(report, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inventory", type=Path, nargs="?")
    parser.add_argument("--report", type=Path, default=Path(".reach/publication/report.json"))
    parser.add_argument("--test-mode", action="store_true", help="Allow loopback HTTP fixture downloads")
    parser.add_argument("--gitleaks", type=Path, help="Pinned scanner executable")
    parser.add_argument("--fingerprint", type=Path, help="Print a local file/tree digest without approving it")
    parser.add_argument("--revision", help="With --fingerprint, fingerprint all Git objects reachable from this reference")
    parser.add_argument("--plan-sha256", action="store_true", help="Print the inventory plan digest for review binding")
    args = parser.parse_args()
    try:
        if args.fingerprint:
            if args.revision:
                revision, objects = git_objects(args.fingerprint, args.revision)
                print(git_digest(revision, objects))
            elif args.fingerprint.is_dir():
                print(tree_snapshot(args.fingerprint)["sha256"])
            else:
                print(sha256(args.fingerprint.read_bytes()))
            return
        if not args.inventory:
            parser.error("an inventory or --fingerprint is required")
        inventory = json.loads(args.inventory.read_text())
        if args.plan_sha256:
            validate_inventory(inventory)
            print(plan_digest(inventory))
            return
        report = scan_inventory(inventory, args.inventory.resolve().parent, args.gitleaks, args.test_mode)
        report = assess_readiness(inventory, report, args.inventory.resolve().parent)
        write_private_report(args.report, report, Path(__file__).resolve().parent.parent)
    except (ValueError, OSError, json.JSONDecodeError):
        parser.exit(1, "Publication verification failed; inspect the private inventory and evidence path.\n")
    print(f"Publication status: {report['status']}; coverage: {report['coverage']}; items: {len(report['items'])}")
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
