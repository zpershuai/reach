#!/usr/bin/env python3
"""Export a committed source candidate without publishing or copying history."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import subprocess
import tempfile


EXCLUDED_PARTS = {".git", ".reach", "node_modules", "target", "dist", "__pycache__"}
EXCLUDED_DEPLOY = {"engines.json", "update", "data"}


def git(repository, *args):
    result = subprocess.run(
        ["git", "-C", str(repository), *args], capture_output=True, check=False
    )
    if result.returncode:
        raise ValueError("Git could not read the selected committed source")
    return result.stdout


def exportable(name):
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ValueError("Unsafe committed source path")
    if any(part in EXCLUDED_PARTS for part in path.parts):
        return False
    if path.name == ".env" or path.name.endswith((".env", ".log", ".pyc")):
        return False
    if path.parts[0] == "deploy" and len(path.parts) > 1:
        if path.parts[1] in EXCLUDED_DEPLOY:
            return False
    return path.name != ".DS_Store"


def export_source(repository, revision, output, include=None):
    repository = Path(repository).resolve()
    output = Path(output).absolute()
    if output.is_symlink() or any(parent.is_symlink() for parent in output.parents):
        raise ValueError("Candidate path must not traverse symbolic links")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Candidate directory must be empty")
    if ".git" in output.parts or output == repository:
        raise ValueError("Candidate must be separate from source and Git metadata")
    commit = git(repository, "rev-parse", "--verify", f"{revision}^{{commit}}").decode().strip()
    entries = []
    for record in git(repository, "ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        metadata, raw_name = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        name = raw_name.decode("utf-8", errors="strict")
        if not exportable(name) or include is not None and name not in include:
            continue
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise ValueError("Candidate contains a symlink, submodule or unsupported entry")
        entries.append((name, oid, mode))
    if include is not None and include != {name for name, _, _ in entries}:
        raise ValueError("Approved file list contains missing or excluded paths")
    if not any(name == "LICENSE" for name, _, _ in entries):
        raise ValueError("Candidate must preserve the root LICENSE")
    attribution = {
        record.split(b"\t", 1)[1].decode()
        for record in git(repository, "ls-tree", "-z", commit).split(b"\0")
        if record and record.split(b"\t", 1)[1].decode().startswith(("NOTICE", "COPYING", "THIRD_PARTY", "THIRD-PARTY"))
    }
    if not attribution.issubset({name for name, _, _ in entries}):
        raise ValueError("Candidate must preserve root notices and attribution")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = []
    with tempfile.TemporaryDirectory(prefix=".reach-source-", dir=output.parent) as directory:
        staged = Path(directory) / "candidate"
        staged.mkdir()
        for name, oid, mode in entries:
            content = git(repository, "cat-file", "blob", oid)
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(0o755 if mode == "100755" else 0o644)
            manifest.append({"path": name, "mode": mode, "sha256": hashlib.sha256(content).hexdigest()})
        if output.exists():
            output.rmdir()  # Fails rather than replacing newly added user files.
        staged.rename(output)
    tree_digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"sourceRevision": commit, "candidateSha256": tree_digest, "files": manifest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--include-list", type=Path, help="Private JSON array of approved repository-relative file paths")
    parser.add_argument("--record", type=Path, help="Write revision mapping and candidate digests to private evidence")
    args = parser.parse_args()
    try:
        include = None
        if args.include_list:
            names = json.loads(args.include_list.read_text())
            if not isinstance(names, list) or any(not isinstance(name, str) for name in names) or len(set(names)) != len(names):
                raise ValueError("Approved file list must contain unique path strings")
            include = set(names)
        report = export_source(args.repo, args.revision, args.output or args.repo / ".reach/public-candidate", include)
        if args.record:
            spec = importlib.util.spec_from_file_location("publication", Path(__file__).with_name("verify-publication.py"))
            publication = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(publication)
            publication.write_private_report(args.record, report, args.repo)
    except (ValueError, OSError, UnicodeError, json.JSONDecodeError):
        parser.exit(1, "Source export failed; check the commit, approved file list and empty candidate path.\n")
    print(f"Source candidate prepared: {len(report['files'])} files; sha256={report['candidateSha256']}")


if __name__ == "__main__":
    main()
