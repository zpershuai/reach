#!/usr/bin/env python3
"""Publish a reviewed candidate. Never replace or delete an existing version."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.error import HTTPError

from release_trust import download


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


plan = load('release_plan', 'release-plan.py')
readback = load('release_readback', 'verify-release-download.py')


def require_absent(repository, path, token):
    try:
        download(f'https://api.github.com/repos/{repository}/{path}', token=token)
    except HTTPError as error:
        code = error.code
        error.close()
        if code == 404:
            return
        raise ValueError('Unable to establish that this release version is unused') from None
    raise ValueError('Existing release must not be overwritten')


def require_source_tag(repository, tag, revision, token):
    """Require an existing component tag; resolve annotated tags without moving it."""
    reference = json.loads(download(f'https://api.github.com/repos/{repository}/git/ref/tags/{tag}', token=token))
    if reference.get('ref') != 'refs/tags/' + tag:
        raise ValueError('Release tag is missing or differs from the candidate')
    target = reference.get('object', {})
    for _ in range(8):
        if not re.fullmatch('[a-f0-9]{40}', target.get('sha', '')):
            break
        if target.get('type') == 'commit':
            if target['sha'] == revision:
                return
            break
        if target.get('type') != 'tag':
            break
        target = json.loads(download(f"https://api.github.com/repos/{repository}/git/tags/{target['sha']}", token=token)).get('object', {})
    raise ValueError('Release tag does not resolve to the approved source revision')


def publish(directory, record, image_archive=None):
    candidate = plan.approve(directory, record, os.environ.get('REACH_APPROVED_CANDIDATE_SHA256', ''), image_archive)
    component = candidate['component']; version = candidate['version']
    repository = plan.metadata.public_repository(component)
    if candidate['source']['repository'] != repository:
        raise ValueError('Official releases must use this repository as their public source')
    token = os.environ.get('GH_TOKEN', '')
    if not token:
        raise ValueError('The publishing job GITHUB_TOKEN is required')
    plan.metadata.public_source(candidate['source']['repository'], candidate['source']['revision'])
    target = json.loads(download(f'https://api.github.com/repos/{repository}', token=token))
    anonymous = json.loads(download(f'https://api.github.com/repos/{repository}'))
    if target.get('private') is not False or anonymous.get('private') is not False:
        raise ValueError('Public distribution must be anonymously accessible')
    tag = f'{component}-v{version}'
    require_absent(repository, 'releases/tags/' + tag, token)
    require_source_tag(repository, tag, candidate['source']['revision'], token)
    manifest = json.loads((directory / 'release-manifest.json').read_text())
    files = [directory / item['name'] for item in manifest['assets']] + [directory / 'release-manifest.json', directory / 'SHA256SUMS']
    with tempfile.TemporaryDirectory() as temporary:
        notes = Path(temporary) / 'notes.md'
        notes.write_text(plan.metadata.release_notes(tag) + '\nSource: ' + candidate['source']['url'] + '\n')
        subprocess.run(['gh', 'release', 'create', tag, '--repo', repository, '--draft', '--verify-tag', '--title', f'Reach {component} {version}', '--notes-file', str(notes), *map(str, files)], check=True)
    subprocess.run(['gh', 'release', 'edit', tag, '--repo', repository, '--draft=false'], check=True)
    result = readback.verify(directory / 'release-manifest.json', repository, tag)
    readback.publication.write_private_report(Path('.reach/publication/published-readback.json'), result, plan.metadata.ROOT)
    if result['status'] != 'passed':
        raise ValueError('Release readback is incomplete; retain the existing release for investigation')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--image-archive', type=Path)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    try:
        if args.publish:
            publish(args.directory, args.record, args.image_archive)
        else:
            value = plan.identity(args.directory, args.image_archive)
            print(json.dumps({'dryRun': True, 'candidateSha256': plan.fingerprint(value), 'component': value['component'], 'version': value['version']}))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        parser.exit(1, 'RELEASE_INCOMPLETE: inspect private evidence; no existing release is overwritten or deleted\n')


if __name__ == '__main__': main()
