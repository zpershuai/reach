"""Certificate fixtures must not inherit host OpenSSL request extensions."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class TLSFixtureTests(unittest.TestCase):
    def test_host_configuration_does_not_add_extensions_or_change_identities(self):
        with tempfile.TemporaryDirectory(prefix='reach-tls-generator-') as temporary:
            root = Path(temporary)
            host = root / 'host.cnf'
            host.write_text('''[req]
distinguished_name=subject
x509_extensions=host_extensions
req_extensions=host_extensions
[subject]
CN=host-default
[host_extensions]
basicConstraints=critical,CA:TRUE
subjectAltName=DNS:inherited.example.com
''')
            output = root / 'certificates'
            generated = subprocess.run(
                [sys.executable, str(Path(__file__).with_name('tls-test-fixture.py')), str(output)],
                env={**os.environ, 'OPENSSL_CONF': str(host)}, capture_output=True, timeout=30,
            )
            self.assertEqual(generated.returncode, 0, 'ephemeral certificate generation failed')
            for name in ['ca', 'trusted', 'wrong-host', 'expired', 'untrusted']:
                inspected = subprocess.run(
                    ['openssl', 'x509', '-in', str(output / f'{name}.crt'), '-text', '-noout'],
                    capture_output=True, text=True, check=True, timeout=10,
                ).stdout
                self.assertNotIn('inherited.example.com', inspected, name)
                for extension in ['Basic Constraints', 'Key Usage', 'Extended Key Usage', 'Subject Alternative Name']:
                    self.assertLessEqual(inspected.count('X509v3 ' + extension + ':'), 1, (name, extension))
                if name == 'trusted':
                    self.assertIn('DNS:localhost', inspected)
                    self.assertIn('IP Address:127.0.0.1', inspected)
                elif name == 'wrong-host':
                    self.assertIn('DNS:wrong.example.com', inspected)
                    self.assertNotIn('DNS:localhost', inspected)
            for name in ['ca.key', 'leaf.key', 'leaf-key.der']:
                self.assertEqual((output / name).stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
