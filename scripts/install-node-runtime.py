#!/usr/bin/env python3
"""Install Reach's pinned Node distribution without requiring a system Node."""

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_node(directory, version, target):
    node = directory / 'bin/node'
    actual_version = subprocess.check_output([str(node), '--version'], text=True, timeout=30).strip()
    actual_target = subprocess.check_output(
        [str(node), '-p', 'process.platform + "-" + process.arch'], text=True, timeout=30,
    ).strip()
    node_target = target[:-5] if target.endswith('-musl') else target
    if (actual_version, actual_target) != (version, node_target):
        raise ValueError(f'Unexpected Node runtime: {actual_version} {actual_target}')
    if not (directory / 'bin/npm').is_file() or not (directory / 'bin/npx').is_file():
        raise ValueError('Node distribution is missing npm or npx')


def install_runtime(reach_root, manifest, target, archive=None):
    version = manifest['version']
    checksum = manifest['sha256'].get(target)
    if not checksum:
        raise ValueError(f'Unsupported Node runtime platform: {target}')
    distribution = f'node-{version}-{target}'
    runtime_root = reach_root / 'runtime'
    runtime_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    current = runtime_root / 'node'
    expected = {'version': version, 'platform': target, 'archiveSha256': checksum}
    try:
        installed = json.loads((current / '.reach-node.json').read_text())
        if isinstance(installed, dict) and all(installed.get(key) == value for key, value in expected.items()):
            if sha256(current / 'bin/node') == installed.get('nodeSha256'):
                validate_node(current, version, target)
                return current / 'bin/node'
    except (OSError, ValueError, subprocess.SubprocessError):
        pass

    with tempfile.TemporaryDirectory(prefix='.node-install-', dir=runtime_root) as staging:
        staging = Path(staging)
        if archive is None:
            archive = staging / f'{distribution}.tar.gz'
            url = f'https://nodejs.org/dist/{version}/{archive.name}'
            print(f'Downloading Reach Node runtime: {url}', file=sys.stderr)
            with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as output:
                shutil.copyfileobj(response, output)
        if sha256(archive) != checksum:
            raise ValueError(f'Node archive SHA-256 mismatch: {archive}')
        subprocess.run(['tar', '-xzf', str(archive), '-C', str(staging)], check=True)
        extracted = staging / distribution
        validate_node(extracted, version, target)
        metadata = {**expected, 'nodeSha256': sha256(extracted / 'bin/node')}
        (extracted / '.reach-node.json').write_text(json.dumps(metadata, indent=2) + '\n')
        installed = runtime_root / f'{distribution}.{uuid.uuid4().hex}'
        extracted.rename(installed)
        # Replace only the pointer after download, checksum and execution checks succeed.
        pointer = runtime_root / f'.node-link-{uuid.uuid4().hex}'
        try:
            pointer.symlink_to(installed.name, target_is_directory=True)
            os.replace(pointer, current)
        finally:
            pointer.unlink(missing_ok=True)
    return current / 'bin/node'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.home() / '.reach')
    parser.add_argument('--archive', type=Path, help='Use a locally supplied official archive (checksum is still verified).')
    args = parser.parse_args()
    systems = {'Darwin': 'darwin', 'Linux': 'linux'}
    architectures = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}
    target = f'{systems.get(platform.system(), platform.system())}-{architectures.get(platform.machine(), platform.machine())}'
    if target == 'linux-x64' and Path('/lib/ld-musl-x86_64.so.1').exists():
        target = 'linux-x64-musl'
    manifest = json.loads(Path(__file__).with_name('node-runtime.json').read_text())
    try:
        archive = args.archive.expanduser().resolve() if args.archive else None
        print(install_runtime(args.root.expanduser().resolve(), manifest, target, archive))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Reach Node runtime installation failed: {error}\n')


if __name__ == '__main__':
    main()
