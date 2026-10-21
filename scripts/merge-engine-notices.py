#!/usr/bin/env python3
"""Require each platform's build notices and create the common Engine notice bundle."""
import argparse
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import tempfile
import shutil

TARGETS = {'engine-linux-x64-musl':'x86_64-unknown-linux-musl',
           'engine-darwin-arm64':'aarch64-apple-darwin', 'engine-darwin-x64':'x86_64-apple-darwin'}


def merge(directory, source=None):
    source = source or Path(__file__).resolve().parent.parent
    contents = []
    compilers = set()
    for asset, target in TARGETS.items():
        if not (directory / (asset + '.NOTICES.txt')).is_file(): raise ValueError('Missing platform notices')
        with tarfile.open(directory / (asset + '.licenses.tgz'), 'r:gz') as archive:
            identity = json.load(archive.extractfile('LICENSES/platform.json'))
            if identity.get('target') != target: raise ValueError('Platform notice identity mismatch')
            compilers.add(identity['rustVersion'])
            required = {'LICENSES/inventory.json','LICENSES/runtimes/rust/COPYRIGHT-library.html','LICENSES/runtimes/musl-COPYRIGHT.txt'}
            observed = set()
            for member in archive:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'LICENSES': raise ValueError('Unsafe platform notice path')
                if member.isdir(): continue
                if not member.isfile() or member.size > 32 * 1024 * 1024: raise ValueError('Unsupported platform notice entry')
                observed.add(member.name)
                contents.append((f'LICENSES/{asset}/' + '/'.join(path.parts[1:]), archive.extractfile(member).read()))
            if not required <= observed: raise ValueError('Incomplete platform runtime notices')
    if len(compilers) != 1: raise ValueError('Engine platform compiler versions differ')
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'LICENSE', directory / 'LICENSE')
    (directory / 'THIRD_PARTY_NOTICES.txt').write_text('Reach Engine third-party notices\n\nEach distributed platform includes its own exact-toolchain and dependency inventory.\n' +
        '\n'.join(f'{asset}: {target}; Rust {next(iter(compilers))}; see {asset}.NOTICES.txt and {asset}.licenses.tgz' for asset,target in TARGETS.items()) +
        '\n\nThe common third-party-licenses.tgz reproduces all platform notices under LICENSES/<asset>/.\n')
    with tempfile.NamedTemporaryFile(dir=directory, prefix='.notices-', delete=False) as output: temporary=Path(output.name)
    try:
        with tarfile.open(temporary, 'w:gz') as archive:
            for name, data in sorted(contents):
                entry=tarfile.TarInfo(name); entry.size=len(data); entry.mode=0o644; entry.mtime=0
                archive.addfile(entry, io.BytesIO(data))
        temporary.replace(directory / 'third-party-licenses.tgz')
    finally: temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('directory',type=Path)
    args=parser.parse_args(); merge(args.directory)
