#!/usr/bin/env python3
"""Validate component tags, produce checksums and public release notes."""
import argparse
import hashlib
import json
import re
import subprocess
import os
from pathlib import Path
from release_trust import download

ROOT = Path(__file__).resolve().parents[1]
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


def parse_tag(tag, root=ROOT):
    match = re.fullmatch(rf"(engine|gateway)-v({SEMVER})", tag)
    if not match:
        raise ValueError("Expected engine-vX.Y.Z or gateway-vX.Y.Z")
    component, version = match.groups()
    if component == "engine":
        text = (root / "crates/reach-rpc/Cargo.toml").read_text()
        expected = re.search(r'^version = "([^"]+)"', text, re.M).group(1)
    else:
        expected = json.loads((root / "packages/reach-rpc/package.json").read_text())["version"]
    if version != expected:
        raise ValueError(f"{component} tag version {version} does not match manifest {expected}")
    return component, version


def checksums(directory, assets):
    if not assets or len(set(assets)) != len(assets): raise ValueError('Duplicate or empty asset list')
    lines = []
    for asset in assets:
        if Path(asset).name != asset:
            raise ValueError("Asset must be a basename")
        path = directory / asset
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing or empty required asset: {asset}")
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {asset}\n")
    (directory / "SHA256SUMS").write_text("".join(lines))


ENGINE_ASSETS = ['engine-linux-x64-musl', 'engine-darwin-arm64', 'engine-darwin-x64']
COMMON_ASSETS = ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'third-party-licenses.tgz']


def required_assets(component, image=False):
    if component == 'engine':
        return sorted(ENGINE_ASSETS + [asset+suffix for asset in ENGINE_ASSETS for suffix in ['.NOTICES.txt','.licenses.tgz']] + COMMON_ASSETS)
    if component == 'gateway': return sorted(['gateway-amd64.tgz'] + COMMON_ASSETS + (['gateway-image.txt'] if image else []))
    raise ValueError('Unknown release component')


def public_repository(component):
    if component not in ('engine','gateway'): raise ValueError('Unknown release component')
    value=os.environ.get(f'REACH_{component.upper()}_RELEASE_REPOSITORY', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', value): raise ValueError('Configure the public distribution repository')
    return value


def public_source(repository, revision, verify=True):
    if not isinstance(repository,str) or not isinstance(revision,str) or not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', repository) or repository.split('/')[-1] in {'.','..'} or not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('Expected public source repository and exact revision')
    if verify:
        metadata=json.loads(download(f'https://api.github.com/repos/{repository}',limit=1024*1024))
        commit=json.loads(download(f'https://api.github.com/repos/{repository}/commits/{revision}',limit=8*1024*1024))
        if metadata.get('private') is not False or commit.get('sha') != revision: raise ValueError('Public source is not anonymously verifiable')
    return {'repository':repository,'revision':revision,'url':f'https://github.com/{repository}/tree/{revision}'}


def release_platforms(component):
    if component == 'gateway': return [{'asset':'gateway-amd64.tgz','os':'linux','architecture':'x64','format':'tar-gzip'}]
    if component == 'engine': return [
        {'asset':'engine-linux-x64-musl','os':'linux','architecture':'x64','format':'elf64-musl'},
        {'asset':'engine-darwin-arm64','os':'darwin','architecture':'arm64','format':'mach-o64'},
        {'asset':'engine-darwin-x64','os':'darwin','architecture':'x64','format':'mach-o64'}]
    raise ValueError('Unknown release component')


def validate_manifest(manifest, directory=None):
    fields = {'schemaVersion', 'component', 'version', 'source', 'toolchain', 'platforms', 'assets'}
    if not isinstance(manifest, dict) or set(manifest) != fields or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1:
        raise ValueError('Invalid release manifest schema')
    if not isinstance(manifest['version'], str) or not re.fullmatch(SEMVER, manifest['version']):
        raise ValueError('Invalid component version')
    source = manifest['source']
    if not isinstance(source, dict) or set(source) != {'repository', 'revision', 'url'} or public_source(source['repository'], source['revision'], False) != source:
        raise ValueError('Invalid public source identity')
    toolchain = manifest['toolchain']
    if not isinstance(toolchain, dict) or set(toolchain) != {'rust', 'node', 'python'} or any(not isinstance(value, str) or not re.fullmatch(SEMVER, value) for value in toolchain.values()):
        raise ValueError('Invalid toolchain identity')
    if manifest['platforms'] != release_platforms(manifest['component']):
        raise ValueError('Missing or invalid platform identity')
    if not isinstance(manifest['assets'], list):
        raise ValueError('Invalid assets')
    names = []
    for asset in manifest['assets']:
        if not isinstance(asset, dict) or set(asset) != {'name', 'bytes', 'sha256'}:
            raise ValueError('Invalid asset identity')
        if not isinstance(asset['name'], str) or Path(asset['name']).name != asset['name'] or asset['name'] in {'.', '..'}:
            raise ValueError('Invalid asset name')
        if type(asset['bytes']) is not int or asset['bytes'] <= 0 or not isinstance(asset['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', asset['sha256']):
            raise ValueError('Invalid asset identity')
        names.append(asset['name'])
    expected = required_assets(manifest['component'], 'gateway-image.txt' in names)
    if sorted(names) != expected:
        raise ValueError('Missing, duplicate or unapproved manifest asset')
    if directory is not None:
        if {path.name for path in directory.iterdir()} != set(expected) | {'release-manifest.json', 'SHA256SUMS'}:
            raise ValueError('Unapproved release directory entry')
        for asset in manifest['assets']:
            path = directory / asset['name']
            if path.is_symlink() or not path.is_file() or path.stat().st_size != asset['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
                raise ValueError('Asset differs from manifest')
    return manifest


def create_manifest(directory, component, version, source, toolchain, *, image=False):
    if not re.fullmatch(SEMVER,version) or set(source) != {'repository','revision','url'}:
        raise ValueError('Invalid release identity')
    if public_source(source['repository'], source['revision'], verify=False) != source: raise ValueError('Invalid public source URL')
    if set(toolchain) != {'rust','node','python'} or any(not re.fullmatch(SEMVER,value) for value in toolchain.values()):
        raise ValueError('Record exact approved build and verification toolchain versions')
    expected=required_assets(component,image)
    observed={path.name for path in directory.iterdir() if path.name not in {'release-manifest.json','SHA256SUMS'}}
    if observed != set(expected): raise ValueError('Missing or unapproved release asset')
    assets=[]
    for name in expected:
        path=directory/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0: raise ValueError('Invalid required asset')
        assets.append({'name':name,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    platforms=release_platforms(component)
    manifest={'schemaVersion':1,'component':component,'version':version,'source':source,'toolchain':toolchain,
              'platforms':platforms,'assets':assets}
    (directory/'release-manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
    checksums(directory,expected+['release-manifest.json'])
    validate_manifest(manifest,directory)
    return manifest


def release_notes(tag, root=ROOT):
    component, version = parse_tag(tag, root)
    return (f'Reach {component.title()} {version}\n\nVerified component assets, checksums and redistribution notices.\n'
            'Keep existing private configuration and workspaces. Source identity is recorded in release-manifest.json.\n'
            'Distribution tags identify these artifacts. Private history and commit messages are not release notes.\n')


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    tag_parser = sub.add_parser("tag")
    tag_parser.add_argument("tag")
    checksum_parser = sub.add_parser("checksums")
    checksum_parser.add_argument("directory", type=Path)
    checksum_parser.add_argument("assets", nargs="+")
    notes_parser = sub.add_parser("notes")
    notes_parser.add_argument("tag")
    notes_parser.add_argument("output", type=Path)
    manifest_parser=sub.add_parser('manifest')
    manifest_parser.add_argument('tag'); manifest_parser.add_argument('directory',type=Path)
    manifest_parser.add_argument('--source-repository',required=True); manifest_parser.add_argument('--source-revision',required=True)
    manifest_parser.add_argument('--toolchain',type=Path,required=True); manifest_parser.add_argument('--image',action='store_true')
    args = parser.parse_args()
    if args.command == "tag":
        component, version = parse_tag(args.tag)
        print(f"component={component}\nversion={version}")
    elif args.command == "checksums":
        checksums(args.directory, args.assets)
    elif args.command == 'manifest':
        component,version=parse_tag(args.tag)
        subprocess.run(['python3', str(ROOT / 'scripts/verify-toolchain.py')], check=True)
        if json.loads(args.toolchain.read_text()) != json.loads((ROOT / 'scripts/toolchain.json').read_text()):
            raise ValueError('Official metadata toolchain differs from verified pins')
        head=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
        if head != args.source_revision: raise ValueError('Build from the public source revision before generating official metadata')
        if subprocess.check_output(['git','-C',str(ROOT),'status','--porcelain','--untracked-files=normal'],text=True).strip():
            raise ValueError('Official metadata requires an unchanged source checkout')
        source=public_source(args.source_repository,args.source_revision)
        create_manifest(args.directory,component,version,source,json.loads(args.toolchain.read_text()),image=args.image)
    else:
        args.output.write_text(release_notes(args.tag))


if __name__ == "__main__":
    main()
