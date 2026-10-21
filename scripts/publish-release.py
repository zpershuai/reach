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
        if error.code == 404:
            return
        raise ValueError('Unable to establish that this release version is unused') from None
    raise ValueError('Existing release or tag must not be overwritten')


def publish(directory, record, image_archive=None):
    candidate = plan.approve(directory, record, os.environ.get('REACH_APPROVED_CANDIDATE_SHA256', ''), image_archive)
    component = candidate['component']; version = candidate['version']
    repository = plan.metadata.public_repository(component)
    token = os.environ.get('GH_TOKEN', '')
    if not token:
        raise ValueError('A target-scoped release token is required')
    plan.metadata.public_source(candidate['source']['repository'], candidate['source']['revision'])
    target = json.loads(download(f'https://api.github.com/repos/{repository}', token=token))
    anonymous = json.loads(download(f'https://api.github.com/repos/{repository}'))
    if target.get('private') is not False or anonymous.get('private') is not False:
        raise ValueError('Public distribution must be anonymously accessible')
    tag = f'{component}-v{version}'
    require_absent(repository, 'releases/tags/' + tag, token)
    require_absent(repository, 'git/ref/tags/' + tag, token)
    image = os.environ.get('REACH_GATEWAY_IMAGE_REPOSITORY', '') if component == 'gateway' else ''
    if image:
        if image_archive is None or not re.fullmatch(r'ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._/-]*', image) or '..' in image.split('/') or '//' in image:
            raise ValueError('Configure an approved GHCR image repository')
        registry_token = os.environ.get('REACH_GHCR_TOKEN', '')
        registry_user = os.environ.get('REACH_GHCR_USER', '')
        if not registry_token or not re.fullmatch(r'[A-Za-z0-9_-]+', registry_user):
            raise ValueError('A target-scoped registry credential is required')
        os.environ['DOCKER_CONFIG'] = str((plan.metadata.ROOT / '.reach/docker-publish').resolve())
        Path(os.environ['DOCKER_CONFIG']).mkdir(mode=0o700, parents=True, exist_ok=True)
        subprocess.run(['docker', 'login', 'ghcr.io', '--username', registry_user, '--password-stdin'], input=registry_token.encode(), check=True, capture_output=True)
        subprocess.run(['docker', 'load', '--input', str(image_archive)], check=True)
        image_tag = image + ':' + version
        subprocess.run(['docker', 'tag', 'reach-gateway:candidate', image_tag], check=True)
        subprocess.run(['docker', 'push', image_tag], check=True)
        identities = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image_tag], text=True))[0]['RepoDigests']
        identity = next((value for value in identities if re.fullmatch(re.escape(image) + r'@sha256:[a-f0-9]{64}', value)), None)
        if identity is None:
            raise ValueError('Published image has no verified digest')
        readback.verify_image(identity)
        (directory / 'gateway-image.txt').write_text(identity + '\n')
        plan.metadata.create_manifest(directory, component, version, candidate['source'], json.loads((directory / 'release-manifest.json').read_text())['toolchain'], image=True)
        plan.assets.complete(directory)
    manifest = json.loads((directory / 'release-manifest.json').read_text())
    files = [directory / item['name'] for item in manifest['assets']] + [directory / 'release-manifest.json', directory / 'SHA256SUMS']
    with tempfile.TemporaryDirectory() as temporary:
        notes = Path(temporary) / 'notes.md'
        notes.write_text(plan.metadata.release_notes(tag) + '\nSource: ' + candidate['source']['url'] + '\n')
        subprocess.run(['gh', 'release', 'create', tag, '--repo', repository, '--draft', '--target', target['default_branch'], '--title', f'Reach {component} {version}', '--notes-file', str(notes), *map(str, files)], check=True)
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
