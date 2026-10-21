#!/usr/bin/env python3
"""Read back an existing release without modifying its tags, assets or visibility."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
from urllib.parse import urlencode
from urllib.request import Request

from release_trust import download


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


metadata = module('release_metadata', 'release-metadata.py')
publication = module('publication', 'verify-publication.py')
assets = module('release_assets', 'verify-release-assets.py')


def verify_image(reference):
    match = re.fullmatch(r'ghcr\.io/([a-z0-9][a-z0-9._/-]*)@sha256:([a-f0-9]{64})', reference)
    if not match or '..' in match[1].split('/') or '//' in match[1]:
        raise ValueError('Invalid approved image identity')
    name, digest = match.groups()
    headers = {'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'}
    # Anonymous GHCR pull tokens are scoped to this one repository; never accept a server-supplied realm.
    token_url = 'https://ghcr.io/token?' + urlencode({'service': 'ghcr.io', 'scope': f'repository:{name}:pull'})
    token = json.loads(download(token_url, allowed={'https://ghcr.io'}, limit=1024 * 1024))['token']
    if not isinstance(token, str) or not token or '\r' in token or '\n' in token:
        raise ValueError('Invalid image pull token')
    headers['Authorization'] = 'Bearer ' + token
    # Redirects are deliberately forbidden while carrying this registry-scoped credential.
    from urllib.request import build_opener, HTTPRedirectHandler
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    url = f'https://ghcr.io/v2/{name}/manifests/sha256:{digest}'
    with build_opener(NoRedirect()).open(Request(url, headers=headers), timeout=60) as response:
        data = response.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Published image digest differs')
    return digest


def verify(approved_path, repository, tag, *, api_origin='https://api.github.com', test_mode=False, timeout=60, image_verifier=verify_image, asset_verifier=assets.complete):
    approved_bytes = approved_path.read_bytes()
    approved = metadata.validate_manifest(json.loads(approved_bytes))
    if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', repository) or repository.split('/')[-1] in {'.', '..'}:
        raise ValueError('Invalid distribution repository')
    if tag != f"{approved['component']}-v{approved['version']}":
        raise ValueError('Tag differs from approved manifest')
    if not test_mode and api_origin != 'https://api.github.com':
        raise ValueError('Official verification requires GitHub HTTPS')
    report = {'schemaVersion': 1, 'status': 'incomplete', 'approvedManifestSha256': hashlib.sha256(approved_bytes).hexdigest(), 'assets': []}
    try:
        release = json.loads(download(f'{api_origin}/repos/{repository}/releases/tags/{tag}', test_mode=test_mode, timeout=timeout, limit=8 * 1024 * 1024))
        expected = {asset['name']: asset for asset in approved['assets']}
        expected['release-manifest.json'] = {'bytes': len(approved_bytes), 'sha256': hashlib.sha256(approved_bytes).hexdigest()}
        sums = ''.join(f"{expected[name]['sha256']}  {name}\n" for name in [asset['name'] for asset in approved['assets']] + ['release-manifest.json']).encode()
        expected['SHA256SUMS'] = {'bytes': len(sums), 'sha256': hashlib.sha256(sums).hexdigest()}
        assets = release['assets']
        names = [asset['name'] for asset in assets]
        if release.get('tag_name') != tag or release.get('draft') is not False or sorted(names) != sorted(expected):
            raise ValueError('Published asset inventory differs')
        with tempfile.TemporaryDirectory(prefix='reach-release-readback-') as temporary:
            directory = Path(temporary)
            for asset in assets:
                name = asset['name']
                result = {'name': name, 'status': 'incomplete'}
                report['assets'].append(result)
                try:
                    data = download(asset['browser_download_url'], binary=True, limit=expected[name]['bytes'], test_mode=test_mode, timeout=timeout)
                    if len(data) != expected[name]['bytes'] or hashlib.sha256(data).hexdigest() != expected[name]['sha256']:
                        raise ValueError('Published asset differs')
                    (directory / name).write_bytes(data)
                    result['status'] = 'passed'
                except (OSError, ValueError, KeyError):
                    result['code'] = 'ASSET_READBACK_INCOMPLETE'
            if any(item['status'] != 'passed' for item in report['assets']):
                return report
            metadata.validate_manifest(approved, directory)
            asset_verifier(directory)
            if 'gateway-image.txt' in expected:
                image_verifier((directory / 'gateway-image.txt').read_text().strip())
                report['image'] = 'passed'
            if not test_mode:
                metadata.public_source(approved['source']['repository'], approved['source']['revision'])
            report['status'] = 'passed'
    except (OSError, ValueError, KeyError, TypeError):
        report['code'] = 'RELEASE_READBACK_INCOMPLETE'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('approved_manifest', type=Path)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--report', type=Path, default=Path('.reach/publication/release-readback.json'))
    parser.add_argument('--test-mode', action='store_true')
    parser.add_argument('--api-origin', default='https://api.github.com')
    args = parser.parse_args()
    try:
        result = verify(args.approved_manifest, args.repository, args.tag, api_origin=args.api_origin, test_mode=args.test_mode)
    except (OSError, ValueError, KeyError, TypeError):
        result = {'status': 'incomplete', 'code': 'APPROVED_MANIFEST_INVALID'}
    publication.write_private_report(args.report, result, metadata.ROOT)
    print(json.dumps({'status': result['status'], 'assets': len(result.get('assets', []))}))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
