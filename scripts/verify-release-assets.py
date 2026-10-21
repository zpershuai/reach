#!/usr/bin/env python3
"""Verify distribution layouts, executable identity, versions and redistribution notices."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tomllib

from binary_identity import check_executable

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {'engine-linux-x64-musl': 'x86_64-unknown-linux-musl', 'engine-darwin-arm64': 'aarch64-apple-darwin', 'engine-darwin-x64': 'x86_64-apple-darwin'}


def archive_files(data):
    result = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts:
                raise ValueError('Unsafe distribution archive path')
            if member.isdir():
                continue
            if not member.isfile() or member.name in result or member.size > 64 * 1024 * 1024:
                raise ValueError('Invalid distribution archive entry')
            total += member.size
            if total > 512 * 1024 * 1024:
                raise ValueError('Distribution archive exceeds size limit')
            result[member.name] = archive.extractfile(member).read()
    return result


def require(files, names):
    if any(not files.get(name, b'').strip() for name in names):
        raise ValueError('Missing required distribution notice or file')


def engine_platform(directory, asset, version, rust_version=None):
    if asset not in TARGETS:
        raise ValueError('Unsupported Engine asset')
    binary = (directory / asset).read_bytes()
    check_executable(binary, asset.removeprefix('engine-'))
    notices = (directory / (asset + '.NOTICES.txt')).read_bytes()
    if not notices.strip():
        raise ValueError('Missing platform notice')
    files = archive_files((directory / (asset + '.licenses.tgz')).read_bytes())
    require(files, ['LICENSES/platform.json', 'LICENSES/inventory.json', 'LICENSES/runtimes/rust/COPYRIGHT-library.html', 'LICENSES/runtimes/musl-COPYRIGHT.txt', 'LICENSES/runtimes/rust-LICENSE-MIT.txt', 'LICENSES/runtimes/rust-LICENSE-APACHE.txt'])
    identity = json.loads(files['LICENSES/platform.json'])
    if identity.get('target') != TARGETS[asset] or identity.get('componentVersion') != version or identity.get('executableSha256') != hashlib.sha256(binary).hexdigest():
        raise ValueError('Engine version, platform or executable notice binding differs')
    if not re.fullmatch(r'\d+\.\d+\.\d+', identity.get('rustVersion', '')) or rust_version and identity['rustVersion'] != rust_version:
        raise ValueError('Compiler notice version differs')
    inventory = json.loads(files['LICENSES/inventory.json'])
    locked = [p for p in tomllib.loads((ROOT / 'Cargo.lock').read_text())['package'] if p.get('source', '').startswith('registry+')]
    expected = {(p['name'], p['version'], p['checksum']) for p in locked}
    actual = {(p['name'], p['version'], p['checksum']) for p in inventory}
    if actual != expected or len(inventory) != len(expected):
        raise ValueError('Locked crate license inventory differs')
    for package in inventory:
        prefix = f"LICENSES/crates/{package['name']}-{package['version']}/"
        if not package.get('license') or not any(name.startswith(prefix) and data.strip() for name, data in files.items()):
            raise ValueError('Missing crate license text')
    return files


def gateway(directory, version, node_version=None):
    files = archive_files((directory / 'gateway-amd64.tgz').read_bytes())
    legal = archive_files((directory / 'third-party-licenses.tgz').read_bytes())
    require(files, ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'packages/reach-rpc/package.json', 'packages/reach-rpc/dist/gateway-main.js', 'packages/reach-rpc/dist/console/index.html'])
    if files['LICENSE'] != (ROOT / 'LICENSE').read_bytes() or files['LICENSE'] != (directory / 'LICENSE').read_bytes() or files['THIRD_PARTY_NOTICES.txt'] != (directory / 'THIRD_PARTY_NOTICES.txt').read_bytes():
        raise ValueError('Gateway common attribution differs')
    if json.loads(files['packages/reach-rpc/package.json'])['version'] != version:
        raise ValueError('Gateway package version differs')
    require(legal, ['LICENSES/inventory.json', 'LICENSES/runtimes/node/LICENSE'] + [f'LICENSES/fonts/{family}-OFL.txt' for family in ['Geist', 'Geist-Mono', 'Bricolage-Grotesque']])
    for name, data in legal.items():
        if files.get('packages/reach-rpc/dist/licenses/' + name) != data:
            raise ValueError('Bundled Gateway notice differs')
    inventory = json.loads(legal['LICENSES/inventory.json'])
    node = next((item for item in inventory if item['name'] == 'node'), None)
    expected_node = node_version or json.loads((ROOT / 'scripts/node-runtime.json').read_text())['version'].removeprefix('v')
    if node is None or node['version'].removeprefix('v') != expected_node:
        raise ValueError('Node notice version differs')
    for name in ['react', 'react-dom', 'scheduler', 'qrcode-generator', 'vite', '@vitejs/plugin-react', 'ws', 'zod']:
        if not any(item['name'] == name and item.get('license') for item in inventory) or not any(path.startswith('LICENSES/npm/' + name.replace('/', '--') + '/') for path in legal):
            raise ValueError('Missing npm dependency notice')


def complete(directory):
    spec = importlib.util.spec_from_file_location('release_metadata', Path(__file__).with_name('release-metadata.py'))
    metadata = importlib.util.module_from_spec(spec); spec.loader.exec_module(metadata)
    manifest = metadata.validate_manifest(json.loads((directory / 'release-manifest.json').read_text()), directory)
    assets = manifest['assets']
    expected_sums = ''.join(f"{item['sha256']}  {item['name']}\n" for item in assets)
    expected_sums += hashlib.sha256((directory / 'release-manifest.json').read_bytes()).hexdigest() + '  release-manifest.json\n'
    if (directory / 'SHA256SUMS').read_text() != expected_sums:
        raise ValueError('Checksum manifest differs')
    if (directory / 'LICENSE').read_bytes() != (ROOT / 'LICENSE').read_bytes():
        raise ValueError('Project license differs')
    if manifest['component'] == 'gateway':
        gateway(directory, manifest['version'], manifest['toolchain']['node'])
    else:
        common = archive_files((directory / 'third-party-licenses.tgz').read_bytes())
        for asset in TARGETS:
            files = engine_platform(directory, asset, manifest['version'], manifest['toolchain']['rust'])
            for name, data in files.items():
                if common.get('LICENSES/' + asset + '/' + name.removeprefix('LICENSES/')) != data:
                    raise ValueError('Common Engine notices differ')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['engine-platform', 'gateway', 'complete'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--asset', choices=list(TARGETS))
    args = parser.parse_args()
    if args.command == 'complete':
        complete(args.directory)
    elif args.command == 'gateway':
        version = json.loads((ROOT / 'packages/reach-rpc/package.json').read_text())['version']
        gateway(args.directory, version)
    else:
        version = tomllib.loads((ROOT / 'crates/reach-rpc/Cargo.toml').read_text())['package']['version']
        engine_platform(args.directory, args.asset, version)
    print('Distribution assets, versions, platforms and notices verified.')


if __name__ == '__main__': main()
