#!/usr/bin/env python3
"""Validate component tags, produce checksums and public release notes."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
PRIVATE_LINE = re.compile(r"\.reach[/\\]|(?:\S*\.env\b)|[\w.+-]+@[\w.-]+")


def parse_tag(tag, root=ROOT):
    match = re.fullmatch(rf"(engine|gateway)-v({SEMVER})", tag)
    if not match:
        raise ValueError("Expected engine-vX.Y.Z or gateway-vX.Y.Z")
    component, version = match.groups()
    if component == "engine":
        text = (root / "crates/reach-rpc/Cargo.toml").read_text()
        expected = re.search(r'^version = "([^"]+)"', text, re.M).group(1)
    else:
        expected = json.loads((root / "packages/reach-rpc/package.json").read_text())["version"]
    if version != expected:
        raise ValueError(f"{component} tag version {version} does not match manifest {expected}")
    return component, version


def checksums(directory, assets):
    lines = []
    for asset in assets:
        if Path(asset).name != asset:
            raise ValueError("Asset must be a basename")
        path = directory / asset
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing or empty required asset: {asset}")
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {asset}\n")
    (directory / "SHA256SUMS").write_text("".join(lines))


def release_notes(tag, root=ROOT):
    component, _ = parse_tag(tag, root)
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
    # Only ancestors of the tagged commit can be the preceding component tag.
    tags = git("tag", "--merged", tag, "--sort=-version:refname", "--list", f"{component}-v*").splitlines()
    previous = next((t for t in tags if t != tag and re.fullmatch(rf"{component}-v{SEMVER}", t)), None)
    revision = f"{previous}..{tag}" if previous else tag
    commits = git("log", "--reverse", "--format=%s%n%b%x00", revision)
    lines = []
    for commit in commits.split("\0"):
        safe = [line.strip() for line in commit.splitlines() if line.strip() and not PRIVATE_LINE.search(line)]
        if safe:
            lines.append("- " + safe[0])
            lines.extend("  " + line for line in safe[1:])
    return f"Changes for {tag}\n\n" + "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    tag_parser = sub.add_parser("tag")
    tag_parser.add_argument("tag")
    checksum_parser = sub.add_parser("checksums")
    checksum_parser.add_argument("directory", type=Path)
    checksum_parser.add_argument("assets", nargs="+")
    notes_parser = sub.add_parser("notes")
    notes_parser.add_argument("tag")
    notes_parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "tag":
        component, version = parse_tag(args.tag)
        print(f"component={component}\nversion={version}")
    elif args.command == "checksums":
        checksums(args.directory, args.assets)
    else:
        args.output.write_text(release_notes(args.tag))


if __name__ == "__main__":
    main()
