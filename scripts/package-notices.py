#!/usr/bin/env python3
"""Collect upstream license texts; never copy application source or local inventory."""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import time
import tomllib
import urllib.request
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
LEGAL = re.compile(r"(?i)^(?:licen[cs]es?|copying|notice|copyright|authors)(?:[._-]|$)")


def legal_path(path):
    return any(LEGAL.match(part) for part in PurePosixPath(path).parts)


def download(url, limit=32 * 1024 * 1024):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as response:
                data = response.read(limit + 1)
            if len(data) > limit:
                raise ValueError("License source exceeds size limit")
            return data
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def safe_write(root, relative, data):
    parts = PurePosixPath(relative)
    if parts.is_absolute() or ".." in parts.parts:
        raise ValueError("Unsafe license path")
    target = root.joinpath(*parts.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def crate_licenses(package, destination, cargo_home, archives):
    name = f"{package['name']}-{package['version']}"
    candidates = list((cargo_home / "registry/cache").glob(f"*/{name}.crate"))
    archive = archives / f"{name}.crate" if archives else None
    if archive is None or not archive.exists(): archive = candidates[0] if candidates else None
    data = archive.read_bytes() if archive and archive.exists() else download(
        f"https://static.crates.io/crates/{package['name']}/{name}.crate")
    if hashlib.sha256(data).hexdigest() != package["checksum"]:
        raise ValueError(f"Upstream package checksum differs: {name}")
    texts = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        metadata = tomllib.loads(tar.extractfile(f"{name}/Cargo.toml").read().decode())["package"]
        if metadata['name'] != package['name'] or metadata['version'] != package['version']:
            raise ValueError('Upstream crate identity differs')
        for member in tar.getmembers():
            relative = PurePosixPath(member.name).relative_to(name).as_posix()
            if member.isfile() and legal_path(relative):
                texts[relative] = tar.extractfile(member).read()
    if not texts:
        raise ValueError(f"No upstream license text found: {name}")
    for relative, data in texts.items():
        safe_write(destination, f"crates/{name}/{relative}", data)
    return {"name": package["name"], "version": package["version"],
            "license": metadata.get("license"), "checksum": package["checksum"],
            "source": f"https://crates.io/crates/{package['name']}/{package['version']}"}


def collect(component, output, source=ROOT, cargo_home=None, archives=None, npm_source=None, rust_version=None, rust_target=None, executable=None):
    output.mkdir(parents=True, exist_ok=True)
    licenses = output / "LICENSES"
    licenses.mkdir(exist_ok=True)
    shutil.copyfile(source / "LICENSE", output / "LICENSE")
    inventory = []
    if component == "engine":
        if not rust_version or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", rust_version):
            raise ValueError("Supply the exact stable compiler version used for the Engine assets")
        packages = [p for p in tomllib.loads((source / "Cargo.lock").read_text())["package"]
                    if p.get("source", "").startswith("registry+")]
        cargo_home = cargo_home or Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(crate_licenses, p, licenses, cargo_home, archives) for p in packages]
            inventory = [future.result() for future in futures]
        # The runtime uses Rust standard libraries and the Linux asset statically links musl.
        for name, url in {
            "rust-LICENSE-MIT.txt": f"https://raw.githubusercontent.com/rust-lang/rust/{rust_version}/LICENSE-MIT",
            "musl-COPYRIGHT.txt": "https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v1.2.5",
        }.items():
            cached = archives / name.removesuffix(".txt") if archives else None
            data = cached.read_bytes() if cached and cached.exists() else download(url)
            safe_write(licenses, f"runtimes/{name}", data)
        safe_write(licenses, "runtimes/rust-LICENSE-APACHE.txt", (source / "LICENSE").read_bytes())
        # libstd has its own dependencies in addition to this application's Cargo.lock.
        cached_runtime = archives / f"rust-{rust_version}" if archives else None
        copyright_path = cached_runtime / "COPYRIGHT-library.html" if cached_runtime else None
        runtime_texts = {}
        if copyright_path and copyright_path.exists():
            runtime_texts = {p.relative_to(cached_runtime).as_posix(): p.read_bytes()
                             for p in cached_runtime.rglob("*") if p.is_file() and not p.is_symlink() and (p.name == "COPYRIGHT-library.html" or p.relative_to(cached_runtime).parts[0] == "licenses")}
        else:
            local = None
            try:
                running = subprocess.check_output(['rustc', '--version'], text=True).split()[1]
                if running == rust_version:
                    local = Path(subprocess.check_output(['rustc', '--print', 'sysroot'], text=True).strip()) / 'share/doc/rust'
            except (OSError, subprocess.SubprocessError): pass
            if local and (local / 'COPYRIGHT-library.html').exists():
                runtime_texts = {p.relative_to(local).as_posix():p.read_bytes() for p in local.rglob('*')
                                 if p.is_file() and not p.is_symlink() and (p.name == 'COPYRIGHT-library.html' or p.relative_to(local).parts[0] == 'licenses')}
        if not runtime_texts:
            manifest = tomllib.loads(download(f"https://static.rust-lang.org/dist/channel-rust-{rust_version}.toml").decode())
            distribution = manifest["pkg"]["rustc"]["target"][rust_target or "aarch64-apple-darwin"]
            data = download(distribution["xz_url"], limit=128 * 1024 * 1024)
            if hashlib.sha256(data).hexdigest() != distribution["xz_hash"]:
                raise ValueError("Rust compiler distribution checksum differs")
            with tarfile.open(fileobj=io.BytesIO(data)) as tar:
                for member in tar.getmembers():
                    if not member.isfile():
                        continue
                    if member.name.endswith("/COPYRIGHT-library.html"):
                        runtime_texts["COPYRIGHT-library.html"] = tar.extractfile(member).read()
                    elif "/licenses/" in member.name:
                        relative = "licenses/" + member.name.split("/licenses/", 1)[1]
                        runtime_texts[relative] = tar.extractfile(member).read()
        if "COPYRIGHT-library.html" not in runtime_texts:
            raise ValueError("Exact Rust standard-library copyright inventory is missing")
        if rust_target is not None:
            if rust_target not in ['x86_64-unknown-linux-musl','aarch64-apple-darwin','x86_64-apple-darwin']:
                raise ValueError('Unsupported Engine notice target')
            if executable is None or not executable.is_file():
                raise ValueError('Platform notices require the verified executable')
            version = tomllib.loads((source / 'crates/reach-rpc/Cargo.toml').read_text())['package']['version']
            identity = {'target': rust_target, 'rustVersion': rust_version, 'componentVersion': version,
                        'executableSha256': hashlib.sha256(executable.read_bytes()).hexdigest()}
            safe_write(licenses, 'platform.json', (json.dumps(identity)+'\n').encode())
        for relative, data in runtime_texts.items():
            safe_write(licenses, "runtimes/rust/" + relative, data)
        summary = ("This conservative inventory includes all Cargo.lock packages, including build, "
                   "development and alternate-target packages that may not be linked in every binary. "
                   "For dual/multi-licensed packages, a permissive MIT/Apache/ISC alternative is selected "
                   "where offered; all collected upstream license notices are retained.\n")
    else:
        npm_source = npm_source or source
        for name in ["react", "react-dom", "scheduler", "qrcode-generator", "vite", "@vitejs/plugin-react", "ws", "zod"]:
            candidates = [npm_source / f"packages/{package}/node_modules/{name}"
                          for package in ["gateway-console", "reach-rpc"]]
            package = next((p for p in candidates if (p / "package.json").exists()), None)
            if package is None:
                raise ValueError(f"Install locked build dependencies before collecting notices: {name}")
            metadata = json.loads((package / "package.json").read_text())
            texts = {p.name: p.read_bytes() for p in package.iterdir() if p.is_file() and LEGAL.match(p.name)}
            if name == "qrcode-generator" and not texts:
                cached = archives / "qrcode-generator-LICENSE" if archives else None
                texts["LICENSE"] = cached.read_bytes() if cached and cached.exists() else download(
                    "https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/master/LICENSE")
            if not texts:
                raise ValueError(f"No upstream license text found: {name}")
            for relative, data in texts.items():
                safe_write(licenses, f"npm/{name.replace('/', '--')}/{relative}", data)
            inventory.append({"name": name, "version": metadata["version"], "license": metadata.get("license")})
        for family in ['Geist', 'Geist-Mono', 'Bricolage-Grotesque']:
            path = source / f'packages/gateway-console/public/fonts/{family}-OFL.txt'
            if not path.is_file() or not path.read_bytes().strip(): raise ValueError('Missing distributed font notice')
            safe_write(licenses, f"fonts/{path.name}", path.read_bytes())
        node_version = json.loads((source / 'scripts/node-runtime.json').read_text())['version']
        node_license = archives / 'node-LICENSE' if archives else None
        data = node_license.read_bytes() if node_license and node_license.exists() else download(f'https://raw.githubusercontent.com/nodejs/node/{node_version}/LICENSE', limit=8*1024*1024)
        safe_write(licenses, 'runtimes/node/LICENSE', data)
        inventory.append({'name':'node','version':node_version,'license':'MIT and included upstream notices'})
        summary = ("Gateway bundles readable JavaScript. Font notices are reproduced under LICENSES/fonts "
                   "and in the console assets. Runtime ws/zod dependencies also retain their own licenses "
                   "when installed by npm. Node and container base-image notices remain with those runtimes.\n")
    inventory.sort(key=lambda p: (p["name"], p["version"]))
    (output / "THIRD_PARTY_NOTICES.txt").write_text(
        "Reach third-party notices\n\n" + summary + "\n" +
        "\n".join(f"{p['name']} {p['version']}: {p.get('license')}" for p in inventory) +
        "\n\nComplete upstream notices are included in LICENSES/ and third-party-licenses.tgz.\n")
    safe_write(licenses, "inventory.json", (json.dumps(inventory, indent=2) + "\n").encode())
    with tarfile.open(output / "third-party-licenses.tgz", "w:gz") as tar:
        tar.add(licenses, arcname="LICENSES")
    return inventory


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=["engine", "gateway"])
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", type=Path, default=ROOT)
    parser.add_argument("--cargo-home", type=Path)
    parser.add_argument("--archives", type=Path)
    parser.add_argument("--npm-source", type=Path)
    parser.add_argument("--rust-version")
    parser.add_argument("--rust-target")
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    packages = collect(args.component, args.output, args.source, args.cargo_home, args.archives, args.npm_source, args.rust_version, args.rust_target, args.executable)
    print(f"Collected notices for {len(packages)} {args.component} dependencies")

