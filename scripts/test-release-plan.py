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
        for response in [b'{}', HTTPError('https://api.github.com', 500, 'fixture', {}, None)]:
            with patch.object(publisher, 'download', side_effect=response if isinstance(response, Exception) else None, return_value=response):
                with self.assertRaises(ValueError): publisher.require_absent('example/releases', 'releases/tags/engine-v1.2.3', 'fixture')
        with patch.object(publisher, 'download', side_effect=HTTPError('https://api.github.com', 404, 'fixture', {}, None)):
            publisher.require_absent('example/releases', 'releases/tags/engine-v1.2.3', 'fixture')


if __name__ == '__main__': unittest.main()
