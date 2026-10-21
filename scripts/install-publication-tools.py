#!/usr/bin/env python3
"""Install the pinned scanner into ignored local tooling after checksum verification."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
PIN = json.loads(Path(__file__).with_name("publication-tools.json").read_text())["gitleaks"]


class ScannerRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        parsed = urllib.parse.urlsplit(new_url)
        if parsed.scheme != "https" or parsed.hostname not in {"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"} or parsed.username or parsed.password:
            raise ValueError("Unsafe scanner download redirect")
        return super().redirect_request(request, fp, code, message, headers, new_url)


class ScannerInstallError(ValueError):
    """A failure whose message names the failed step and never includes downloaded content."""


def download(url):
    opener = urllib.request.build_opener(ScannerRedirect())
    for attempt in range(3):
        try:
            with opener.open(url, timeout=30) as response:
                content = response.read(64 * 1024 * 1024 + 1)
            if len(content) > 64 * 1024 * 1024:
                raise ScannerInstallError("Scanner download exceeds limit")
            return content
        except OSError:
            if attempt == 2:
                raise ScannerInstallError("Scanner download failed after 3 attempts; check network access to github.com")
            time.sleep(2 * (attempt + 1))


def install(destination, archive=None):
    system = platform.system().lower()
    architecture = {"x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine())
    target = f"{system}_{architecture}"
    if target not in PIN["sha256"]:
        raise ValueError("No pinned scanner for this platform")
    name = f"gitleaks_{PIN['version']}_{target}.tar.gz"
    destination = Path(destination).absolute()
    # A previously verified archive is reused only while it still matches the pinned digest.
    cached = destination / name
    if archive:
        content = Path(archive).read_bytes()
    elif cached.is_file() and not cached.is_symlink() and hashlib.sha256(cached.read_bytes()).hexdigest() == PIN["sha256"][target]:
        content = cached.read_bytes()
    else:
        content = download(f"https://github.com/{PIN['repository']}/releases/download/v{PIN['version']}/{name}")
    if hashlib.sha256(content).hexdigest() != PIN["sha256"][target]:
        raise ScannerInstallError("Scanner archive checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as package:
        binary = package.getmember("gitleaks")
        if not binary.isfile() or binary.size > 64 * 1024 * 1024:
            raise ValueError("Scanner archive lacks its regular executable")
        payload = package.extractfile(binary).read()
    if destination.is_symlink() or any(parent.is_symlink() for parent in destination.parents):
        raise ValueError("Scanner destination cannot traverse symlinks")
    if destination.is_relative_to(ROOT) and not destination.is_relative_to(ROOT / ".reach"):
        raise ValueError("Local scanner tooling must remain ignored under .reach/")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=destination, prefix=".gitleaks-", delete=False) as staged:
        path = Path(staged.name)
        try:
            os.fchmod(staged.fileno(), 0o700)
            staged.write(payload)
            staged.flush()
            path.replace(destination / "gitleaks")
        finally:
            path.unlink(missing_ok=True)
    if not cached.exists():
        with tempfile.NamedTemporaryFile(dir=destination, prefix=".archive-", delete=False) as staged:
            path = Path(staged.name)
            try:
                staged.write(content)
                staged.flush()
                path.replace(cached)
            finally:
                path.unlink(missing_ok=True)
    return destination / "gitleaks"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Previously downloaded, checksum-verified upstream package")
    parser.add_argument("--destination", type=Path, default=ROOT / f".reach/tools/gitleaks-{PIN['version']}")
    args = parser.parse_args()
    try:
        install(args.destination, args.archive)
    except ScannerInstallError as error:
        parser.exit(1, f"Pinned scanner installation failed: {error}.\n")
    except (OSError, ValueError, KeyError, tarfile.TarError):
        parser.exit(1, "Pinned scanner installation failed; check the package, platform and private tools directory.\n")
    print(f"Pinned Gitleaks {PIN['version']} installed; no source or service was modified.")


if __name__ == "__main__":
    main()
