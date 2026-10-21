#!/usr/bin/env python3
"""Reject CI toolchain drift before building or recording release metadata."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def check(expected, observed):
    if set(expected) != {'rust', 'node', 'python'} or set(observed) != set(expected):
        raise ValueError('TOOLCHAIN_IDENTITY_INVALID')
    mismatches = sorted(key for key in expected if expected[key] != observed[key])
    if mismatches:
        raise ValueError('TOOLCHAIN_VERSION_MISMATCH: ' + ','.join(mismatches))
    return observed


def check_npm_lock(directory):
    manifest = json.loads((directory / 'package.json').read_text())
    lock = json.loads((directory / 'package-lock.json').read_text())
    root = lock['packages']['']
    for name in ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies']:
        if manifest.get(name) != root.get(name):
            raise ValueError('NPM_LOCK_DRIFT: ' + name)


def current():
    rust = subprocess.check_output(['rustc', '--version'], text=True).split()[1]
    node = subprocess.check_output(['node', '--version'], text=True).strip().removeprefix('v')
    return {'rust': rust, 'node': node, 'python': '.'.join(map(str, sys.version_info[:3]))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        value = check(json.loads((ROOT / 'scripts/toolchain.json').read_text()), current())
        for directory in [ROOT, ROOT / 'packages/reach-rpc', ROOT / 'packages/gateway-console']:
            check_npm_lock(directory)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')
    if args.output:
        args.output.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    print('Pinned Rust/Node/Python toolchain verified.')


if __name__ == '__main__': main()
