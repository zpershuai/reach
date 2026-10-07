#!/usr/bin/env python3
"""Update a specified existing Caddy site after checking its Gateway upstream."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from urllib.request import urlopen


def domain_name(value):
    if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', value):
        raise argparse.ArgumentTypeError('domain must be a DNS hostname without a scheme or path')
    return value


def upstream_address(value):
    match = re.fullmatch(r'(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):([0-9]+)', value)
    if not match or not 1 <= int(match.group(1)) <= 65535:
        raise argparse.ArgumentTypeError('upstream must be a host:port address')
    return value


def replace_site(original, domain, upstream):
    match = re.search(r'^[ \t]*(?:https://)?' + re.escape(domain) + r'[ \t]*\{', original, re.MULTILINE)
    if match is None:
        raise ValueError('The specified site does not exist; add its initial configuration first')
    depth = 0
    end = None
    for index in range(match.end() - 1, len(original)):
        if original[index] == '{':
            depth += 1
        elif original[index] == '}':
            depth -= 1
            if depth == 0:
                end = index + 1
                break
    if end is None:
        raise ValueError('Cannot locate the end of the specified site')
    replacement = (f'{domain} {{\n'
                   '    request_body {\n        max_size 64KB\n    }\n'
                   f'    reverse_proxy {upstream}\n}}')
    return original[:match.start()] + replacement + original[end:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', required=True, type=domain_name)
    parser.add_argument('--upstream', default='127.0.0.1:28787', type=upstream_address)
    parser.add_argument('--config', type=Path, default=Path('/etc/caddy/Caddyfile'))
    parser.add_argument('--service', default='caddy', help='systemd service to reload')
    args = parser.parse_args()
    with urlopen(f'http://{args.upstream}/healthz', timeout=5) as response:
        if json.load(response).get('protocol') != 'reach-rpc/1.0':
            raise ValueError('Upstream is not a Reach Gateway')
    config = args.config
    updated = replace_site(config.read_text(), args.domain, args.upstream)
    candidate = config.with_name(config.name + '.reach-candidate')
    shutil.copy2(config, candidate)
    candidate.write_text(updated)
    subprocess.run(['caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'], check=True)
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = config.with_name(config.name + '.before-reach-' + timestamp)
    shutil.copy2(config, backup)
    os.replace(candidate, config)
    try:
        subprocess.run(['systemctl', 'reload', args.service], check=True)
    except subprocess.CalledProcessError:
        shutil.copy2(backup, config)
        subprocess.run(['systemctl', 'reload', args.service], check=True)
        raise
    print('Gateway proxy updated; previous config:', backup)


if __name__ == '__main__':
    main()
