#!/usr/bin/env python3
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('readback', Path(__file__).with_name('verify-release-download.py'))
readback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readback)


class ReadbackTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in readback.metadata.required_assets('gateway', True):
            (self.root / name).write_bytes(('fixture-' + name).encode())
        (self.root / 'gateway-image.txt').write_text('ghcr.io/example/reach-gateway@sha256:' + 'a' * 64 + '\n')
        readback.metadata.create_manifest(self.root, 'gateway', '1.2.3', readback.metadata.public_source('example/reach-source', 'b' * 40, False), {'rust': '1.96.0', 'node': '24.21.0', 'python': '3.14.5'}, image=True)
        self.files = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.delay = None
        self.requests = []
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                owner.requests.append(('GET', self.path))
                name = self.path.rsplit('/', 1)[-1]
                if '/releases/tags/' in self.path:
                    data = json.dumps({'tag_name': 'gateway-v1.2.3', 'draft': False, 'assets': [{'name': n, 'browser_download_url': owner.origin + '/assets/' + n} for n in owner.files]}).encode()
                else:
                    if name == owner.delay: time.sleep(.2)
                    data = owner.files.get(name)
                    if data is None:
                        self.send_error(404); return
                self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers()
                try: self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def verify(self, **kwargs):
        return readback.verify(self.root / 'release-manifest.json', 'example/reach-releases', 'gateway-v1.2.3', api_origin=self.origin, test_mode=True, asset_verifier=lambda _: None, **kwargs)

    def test_registry_manifest_bytes_must_match_the_approved_image_digest(self):
        data = b'{"schemaVersion":2,"fixture":true}'
        digest = hashlib.sha256(data).hexdigest()
        class Opener:
            def open(self, request, **kwargs):
                self.request = request
                return io.BytesIO(data)
        opener = Opener()
        with patch.object(readback, 'download', return_value=b'{"token":"fixture-pull-token"}'), patch('urllib.request.build_opener', return_value=opener):
            self.assertEqual(readback.verify_image('ghcr.io/example/reach-gateway@sha256:' + digest), digest)
            self.assertEqual(opener.request.host, 'ghcr.io')
            with self.assertRaisesRegex(ValueError, 'digest differs'):
                readback.verify_image('ghcr.io/example/reach-gateway@sha256:' + 'a' * 64)
        with self.assertRaises(ValueError): readback.verify_image('http://registry.example.invalid/image:latest')

    def test_complete_exact_bytes_and_image_digest_are_required(self):
        images = []
        self.assertEqual(self.verify(image_verifier=images.append)['status'], 'passed')
        self.assertEqual(images, ['ghcr.io/example/reach-gateway@sha256:' + 'a' * 64])
        self.assertTrue(all(method == 'GET' for method, _ in self.requests))
        def mismatch(_): raise ValueError('wrong published image')
        self.assertEqual(self.verify(image_verifier=mismatch)['status'], 'incomplete')

    def test_missing_extra_corrupt_and_timeout_never_pass_or_modify_release(self):
        original = self.files.copy()
        cases = ['missing', 'extra', 'corrupt', 'timeout']
        for case in cases:
            self.files = original.copy(); self.delay = None
            if case == 'missing': del self.files['LICENSE']
            if case == 'extra': self.files['private.env'] = b'unapproved'
            if case == 'corrupt': self.files['LICENSE'] = b'corrupt'
            if case == 'timeout': self.delay = 'THIRD_PARTY_NOTICES.txt'
            with self.subTest(case=case):
                result = self.verify(timeout=.05, image_verifier=lambda _: None)
                self.assertEqual(result['status'], 'incomplete')
                self.assertTrue(all(method == 'GET' for method, _ in self.requests))
                self.assertEqual((self.root / 'LICENSE').read_bytes(), original['LICENSE'])

    def test_http_and_changed_approved_metadata_require_explicit_fixture_mode(self):
        with self.assertRaises(ValueError):
            readback.verify(self.root / 'release-manifest.json', 'example/reach-releases', 'gateway-v1.2.3', api_origin=self.origin)
        with self.assertRaises(ValueError):
            readback.verify(self.root / 'release-manifest.json', 'example/reach-releases', 'gateway-v1.2.4')
        self.assertFalse(any('/tags/gateway-v1.2.4' in path for _, path in self.requests))


if __name__ == '__main__': unittest.main()
