#!/usr/bin/env python3
"""Generate ephemeral TLS certificates for isolated Reach verification only."""

from pathlib import Path
import subprocess
import sys


def generate(directory):
    directory = Path(directory).resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)

    def openssl(*args):
        subprocess.run(['openssl', *map(str, args)], cwd=directory, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)

    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key',
            '-out', 'ca.crt', '-subj', '/CN=Reach Ephemeral Test CA', '-days', '2',
            '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key',
            '-out', 'leaf.csr', '-subj', '/CN=localhost')
    for index, (name, san) in enumerate([('trusted', 'DNS:localhost,IP:127.0.0.1'), ('wrong-host', 'DNS:wrong.example.com')], 1):
        extensions = directory / f'{name}.ext'
        extensions.write_text(f'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName={san}\n')
        openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
                '-set_serial', index, '-out', f'{name}.crt', '-days', '2', '-extfile', extensions)
    (directory / 'index.txt').write_text('')
    (directory / 'serial').write_text('1000\n')
    (directory / 'newcerts').mkdir()
    config = directory / 'ca.cnf'
    config.write_text('''[ca]
default_ca=fixture
[fixture]
database=index.txt
new_certs_dir=newcerts
serial=serial
private_key=ca.key
certificate=ca.crt
default_md=sha256
policy=policy
x509_extensions=server
[policy]
commonName=supplied
[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
''')
    openssl('ca', '-batch', '-notext', '-config', config, '-in', 'leaf.csr', '-out', 'expired.crt',
            '-startdate', '20000101000000Z', '-enddate', '20010101000000Z')
    openssl('req', '-x509', '-key', 'leaf.key', '-out', 'untrusted.crt', '-days', '2',
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1')
    for name in ['ca', 'trusted', 'wrong-host', 'expired', 'untrusted']:
        openssl('x509', '-in', f'{name}.crt', '-outform', 'DER', '-out', f'{name}.der')
    openssl('pkcs8', '-topk8', '-nocrypt', '-in', 'leaf.key', '-outform', 'DER', '-out', 'leaf-key.der')
    for path in directory.iterdir():
        if path.is_file():
            path.chmod(0o600)


if __name__ == '__main__':
    generate(sys.argv[1])
