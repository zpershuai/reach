#!/usr/bin/env python3
"""Create a public candidate identity, scan its exact bytes and bind publication approval."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


assets = load('assets', 'verify-release-assets.py')
metadata = load('metadata', 'release-metadata.py')
publication = load('publication', 'verify-publication.py')


def identity(directory, image_archive=None):
    manifest = assets.complete(directory)
    result = {'schemaVersion': 1, 'component': manifest['component'], 'version': manifest['version'],
              'source': manifest['source'], 'manifestSha256': hashlib.sha256((directory / 'release-manifest.json').read_bytes()).hexdigest()}
    if image_archive is not None:
        if manifest['component'] != 'gateway' or image_archive.is_symlink() or not image_archive.is_file():
            raise ValueError('Invalid candidate image archive')
        result['imageArchiveSha256'] = hashlib.sha256(image_archive.read_bytes()).hexdigest()
    return result


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def approve(directory, record_path, approval, image_archive=None):
    observed = identity(directory, image_archive)
    record = json.loads(record_path.read_text())
    if record != observed or approval != fingerprint(observed):
        raise ValueError('Candidate approval is missing or does not match these exact bytes')
    return observed


def scan(directory, source, image_archive=None):
    items = [{'id': 'source', 'kind': 'candidate', 'path': str(source.resolve()), 'sha256': publication.tree_snapshot(source)['sha256']}]
    for path in sorted(directory.iterdir()):
        items.append({'id': path.name, 'kind': 'release-asset', 'path': str(path.resolve()), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    if image_archive is not None:
        items.append({'id': 'image', 'kind': 'image', 'path': str(image_archive.resolve()), 'sha256': hashlib.sha256(image_archive.read_bytes()).hexdigest()})
    scope = {kind: [item['id'] for item in items if item['kind'] == kind] for kind in publication.KINDS}
    inventory = {'schemaVersion': 1, 'scope': scope, 'items': items}
    result = publication.scan_inventory(inventory, Path('/'))
    publication.write_private_report(Path('.reach/publication/candidate-scan.json'), result, metadata.ROOT)
    if result['coverage'] != 'complete' or any(item['status'] != 'scanned' for item in result['items']):
        raise ValueError('Candidate scanning failed or is incomplete; inspect the private report')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'approve'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--image-archive', type=Path)
    args = parser.parse_args()
    if args.command == 'approve':
        import os
        approve(args.directory, args.record, os.environ.get('REACH_APPROVED_CANDIDATE_SHA256', ''), args.image_archive)
    else:
        record = identity(args.directory, args.image_archive)
        if args.source is None: raise ValueError('A complete source snapshot is required')
        scan(args.directory, args.source, args.image_archive)
        args.record.write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
        print('candidate-sha256=' + fingerprint(record))


if __name__ == '__main__': main()
