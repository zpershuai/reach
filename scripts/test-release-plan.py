#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


publisher = load('publisher', 'publish-release.py')
fixtures = load('asset_fixtures', 'test-release-assets.py')


class PlanTests(unittest.TestCase):
    def test_candidate_scan_summary_never_logs_match_contents_or_private_paths(self):
        report = {'coverage': 'complete', 'items': [{'id': 'source', 'status': 'findings', 'findings': [{'Secret': 'never-log-this-value', 'File': '/private/fixture', 'Match': 'private-match'}]}]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); release = root / 'release'; release.mkdir()
            source = root / 'source'; source.mkdir()
            with patch.object(publisher.plan.publication, 'scan_inventory', return_value=report), patch.object(publisher.plan.publication, 'write_private_report'), contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(ValueError):
                publisher.plan.scan(release, source)
            text = output.getvalue()
            for private in ['never-log-this-value', '/private/fixture', 'private-match']: self.assertNotIn(private, text)
            self.assertEqual(json.loads(text.removeprefix('candidate-scan='))['items'][0]['findings'], 1)

    def official_fixture(self, root, component):
        if component == 'engine':
            fixtures.AssetTests().fixture(root)
        else:
            packages = ['react', 'react-dom', 'scheduler', 'qrcode-generator', 'vite', '@vitejs/plugin-react', 'ws', 'zod']
            inventory = [{'name': name, 'license': 'MIT'} for name in packages] + [{'name': 'node', 'version': '24.21.0', 'license': 'MIT'}]
            legal = {'LICENSES/inventory.json': json.dumps(inventory).encode(), 'LICENSES/runtimes/node/LICENSE': b'Fixture Node license'}
            legal.update({f'LICENSES/fonts/{name}-OFL.txt': b'Fixture font license' for name in ['Geist', 'Geist-Mono', 'Bricolage-Grotesque']})
            legal.update({f'LICENSES/npm/{name.replace("/", "--")}/LICENSE': b'Fixture npm license' for name in packages})
            (root / 'LICENSE').write_bytes((publisher.plan.metadata.ROOT / 'LICENSE').read_bytes())
            (root / 'THIRD_PARTY_NOTICES.txt').write_bytes(b'Fixture notices')
            files = {'LICENSE': (root / 'LICENSE').read_bytes(), 'THIRD_PARTY_NOTICES.txt': b'Fixture notices', 'packages/reach-rpc/package.json': b'{"version":"1.2.3"}', 'packages/reach-rpc/dist/gateway-main.js': b'fixture', 'packages/reach-rpc/dist/console/index.html': b'fixture'}
            files.update({'packages/reach-rpc/dist/licenses/' + name: data for name, data in legal.items()})
            fixtures.AssetTests().tar(root / 'gateway-amd64.tgz', files)
            fixtures.AssetTests().tar(root / 'third-party-licenses.tgz', legal)
        publisher.plan.metadata.create_manifest(root, component, '1.2.3', publisher.plan.metadata.public_source('zpershuai/reach', 'a' * 40, False), {'rust': '1.96.0', 'node': '24.21.0', 'python': '3.14.5'})
        record = root.parent / 'candidate.json'
        identity = publisher.plan.identity(root)
        record.write_text(json.dumps(identity))
        return record, publisher.plan.fingerprint(identity)

    def test_both_components_publish_only_to_existing_matching_source_tags(self):
        for component in ['engine', 'gateway']:
            with self.subTest(component=component), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / 'release'; root.mkdir()
                record, digest = self.official_fixture(root, component)
                tag = component + '-v1.2.3'
                def download(url, **kwargs):
                    self.assertTrue(url.startswith('https://api.github.com/repos/zpershuai/reach'))
                    if '/releases/tags/' in url: raise HTTPError(url, 404, 'fixture', {}, None)
                    if '/git/ref/tags/' in url: return json.dumps({'ref': 'refs/tags/' + tag, 'object': {'type': 'commit', 'sha': 'a' * 40}}).encode()
                    return b'{"private":false}'
                env = {'GH_TOKEN': 'synthetic-runtime-token', 'REACH_APPROVED_CANDIDATE_SHA256': digest}
                with patch.dict('os.environ', env, clear=True), patch.object(publisher, 'download', side_effect=download), patch.object(publisher.plan.metadata, 'public_source'), patch.object(publisher.plan.metadata, 'release_notes', return_value='Fixture notes'), patch.object(publisher.subprocess, 'run') as commands, patch.object(publisher.readback, 'verify', return_value={'status': 'passed'}) as readback, patch.object(publisher.readback.publication, 'write_private_report'):
                    publisher.publish(root, record)
                self.assertEqual(commands.call_count, 2)
                create, edit = [call.args[0] for call in commands.call_args_list]
                self.assertEqual(create[:6], ['gh', 'release', 'create', tag, '--repo', 'zpershuai/reach'])
                self.assertIn('--verify-tag', create); self.assertIn('--draft', create)
                self.assertNotIn('--target', create)
                self.assertEqual(edit, ['gh', 'release', 'edit', tag, '--repo', 'zpershuai/reach', '--draft=false'])
                self.assertEqual(readback.call_args.args[1:], ('zpershuai/reach', tag))

    def test_existing_tags_must_resolve_to_the_exact_candidate_commit(self):
        tag = 'engine-v1.2.3'; revision = 'a' * 40
        reference = {'ref': 'refs/tags/' + tag, 'object': {'type': 'tag', 'sha': 'b' * 40}}
        with patch.object(publisher, 'download', side_effect=[json.dumps(reference).encode(), json.dumps({'object': {'type': 'commit', 'sha': revision}}).encode()]):
            publisher.require_source_tag('zpershuai/reach', tag, revision, 'synthetic')
        for target in [{'type': 'commit', 'sha': 'c' * 40}, {'type': 'tree', 'sha': revision}, {'type': 'commit', 'sha': '../invalid'}]:
            with patch.object(publisher, 'download', return_value=json.dumps(dict(reference, object=target)).encode()), self.assertRaises(ValueError):
                publisher.require_source_tag('zpershuai/reach', tag, revision, 'synthetic')
        with patch.object(publisher, 'download', side_effect=HTTPError('https://api.github.com', 404, 'fixture', {}, None)), self.assertRaises(HTTPError) as failure:
            publisher.require_source_tag('zpershuai/reach', tag, revision, 'synthetic')
        failure.exception.close()
        with patch.object(publisher, 'download', return_value=json.dumps(dict(reference, ref='refs/heads/' + tag)).encode()), self.assertRaises(ValueError):
            publisher.require_source_tag('zpershuai/reach', tag, revision, 'synthetic')
        with patch.object(publisher, 'download', return_value=json.dumps(dict(reference, object={'type': 'tag', 'sha': 'b' * 40})).encode()) as requests, self.assertRaises(ValueError):
            publisher.require_source_tag('zpershuai/reach', tag, revision, 'synthetic')
        self.assertEqual(requests.call_count, 9)

    def test_missing_or_changed_source_tag_blocks_every_release_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'release'; root.mkdir()
            record, digest = self.official_fixture(root, 'engine')
            with patch.dict('os.environ', {'GH_TOKEN': 'synthetic-runtime-token', 'REACH_APPROVED_CANDIDATE_SHA256': digest}, clear=True), patch.object(publisher.plan.metadata, 'public_source'), patch.object(publisher, 'download', return_value=b'{"private":false}'), patch.object(publisher, 'require_absent'), patch.object(publisher, 'require_source_tag', side_effect=ValueError('Tag differs')), patch.object(publisher.subprocess, 'run', side_effect=AssertionError('Release mutation reached')), self.assertRaises(ValueError):
                publisher.publish(root, record)

    def test_publisher_rejects_cross_repository_source_before_network_or_mutation(self):
        with patch.object(publisher.plan, 'approve', return_value={'component': 'engine', 'version': '1.2.3', 'source': {'repository': 'example/other', 'revision': 'a' * 40}}), patch.object(publisher, 'download', side_effect=AssertionError('Unexpected network')), patch.object(publisher.subprocess, 'run', side_effect=AssertionError('Unexpected mutation')), self.assertRaises(ValueError):
            publisher.publish(Path('unused'), Path('unused'))

    def test_approval_is_bound_to_all_candidate_bytes_and_missing_approval_fails_before_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); directory = root / 'release'; directory.mkdir()
            fixtures.AssetTests().fixture(directory)
            record = root / 'candidate.json'
            identity = publisher.plan.identity(directory)
            record.write_text(json.dumps(identity))
            digest = publisher.plan.fingerprint(identity)
            self.assertEqual(publisher.plan.approve(directory, record, digest), identity)
            with patch.object(publisher, 'download', side_effect=AssertionError('No network before approval')), patch.dict('os.environ', {'REACH_APPROVED_CANDIDATE_SHA256': ''}):
                with self.assertRaises(ValueError): publisher.publish(directory, record)
            (directory / 'LICENSE').write_bytes(b'changed')
            with self.assertRaises(ValueError): publisher.plan.approve(directory, record, digest)

    def test_dry_run_cannot_invoke_publishing_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); fixtures.AssetTests().fixture(root)
            with patch('sys.argv', ['publish-release.py', str(root), '--record', str(root.parent / 'unused.json')]), patch.object(publisher.subprocess, 'run', side_effect=AssertionError('dry run attempted a command')), patch.object(publisher, 'download', side_effect=AssertionError('dry run attempted network')), contextlib.redirect_stdout(io.StringIO()) as output:
                publisher.main()
            self.assertTrue(json.loads(output.getvalue())['dryRun'])

    def test_existing_release_and_network_errors_are_not_treated_as_unused_versions(self):
        for response in [b'{}'] + [HTTPError('https://api.github.com', code, 'fixture', {}, None) for code in [401, 403, 500]]:
            with patch.object(publisher, 'download', side_effect=response if isinstance(response, Exception) else None, return_value=response):
                with self.assertRaises(ValueError): publisher.require_absent('example/releases', 'releases/tags/engine-v1.2.3', 'fixture')
        with patch.object(publisher, 'download', side_effect=HTTPError('https://api.github.com', 404, 'fixture', {}, None)):
            publisher.require_absent('example/releases', 'releases/tags/engine-v1.2.3', 'fixture')


if __name__ == '__main__': unittest.main()
