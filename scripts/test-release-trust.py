#!/usr/bin/env python3
import http.server
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, build_opener
from release_trust import ApprovedRedirect, approve, download


class ReleaseTrustTests(unittest.TestCase):
    def test_production_rejects_unapproved_sources_and_url_credentials(self):
        for url in ['http://api.github.com/x', 'file:///tmp/fixture', 'https://api.github.com.evil.example/x',
                    'https://user:secret@api.github.com/x', 'https://api.github.com:8443/x', 'https://unapproved.example/x',
                    'https://api.github.com/x#secret', 'https://api.github.com/x\nforged']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                approve(url)
        self.assertEqual(approve('https://api.github.com:443/repos/example/reach'), 'https://api.github.com')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture'; path.write_bytes(b'fixture')
            with self.assertRaises(ValueError):
                download(path.as_uri())
            self.assertEqual(download(path.as_uri(), test_mode=True), b'fixture')

    def test_redirects_strip_credentials_only_when_origin_changes(self):
        policy = ApprovedRedirect()
        request = Request('https://api.github.com/repos/example/reach', headers={'Authorization': 'Bearer private-sentinel', 'Cookie': 'private-cookie'})
        same = policy.redirect_request(request, io.BytesIO(), 302, 'Found', {}, '/repos/example/other')
        self.assertEqual(same.get_header('Authorization'), 'Bearer private-sentinel')
        redirected = policy.redirect_request(request, io.BytesIO(), 302, 'Found', {}, 'https://release-assets.githubusercontent.com/fixture')
        self.assertIsNone(redirected.get_header('Authorization')); self.assertIsNone(redirected.get_header('Cookie'))
        returned = policy.redirect_request(redirected, io.BytesIO(), 302, 'Found', {}, 'https://api.github.com/fixture')
        self.assertIsNone(returned.get_header('Authorization'))
        for url in ['http://api.github.com/fixture', 'https://unapproved.example/fixture', 'https://api.github.com.evil.example/fixture']:
            with self.assertRaises(ValueError):
                policy.redirect_request(request, io.BytesIO(), 302, 'Found', {}, url)

    def test_explicit_loopback_fixture_redirect_never_receives_authorization(self):
        received = []
        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                received.append((self.headers.get('Authorization'), self.headers.get('Cookie')))
                self.send_response(200); self.end_headers(); self.wfile.write(b'fixture')
            def log_message(self, *args): pass
        target = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Target)
        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302); self.send_header('Location', f'http://127.0.0.1:{target.server_port}/fixture'); self.end_headers()
            def log_message(self, *args): pass
        redirect = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        for server in [target, redirect]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f'http://127.0.0.1:{redirect.server_port}/fixture'
            with self.assertRaises(ValueError): download(url)
            opener = build_opener(ApprovedRedirect(test_mode=True))
            with opener.open(Request(url, headers={'Authorization': 'Bearer private-sentinel', 'Cookie': 'private-cookie'}), timeout=3) as response:
                self.assertEqual(response.read(), b'fixture')
            self.assertEqual(received, [(None, None)])
        finally:
            for server in [redirect, target]: server.shutdown(); server.server_close()

    def test_installer_requires_an_explicit_fixture_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture'; path.write_bytes(b'fixture')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('release-download.py')), path.as_uri()],
                                    env={'PATH': str(Path(sys.executable).parent)}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'RELEASE_DOWNLOAD_REJECTED', result.stderr)


if __name__ == '__main__': unittest.main()
