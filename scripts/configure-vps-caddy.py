#!/usr/bin/env python3
"""Switch only Reach's existing Caddy site after checking the new Gateway."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import shutil
import subprocess
from urllib.request import urlopen

with urlopen('http://127.0.0.1:28787/healthz', timeout=5) as response:
    assert json.load(response)['protocol'] == 'reach-rpc/1.0'

config = Path('/etc/caddy/Caddyfile')
original = config.read_text()
site = 'reach.zpershuai.top {'
start = original.index(site)
depth = 0
end = None
for index in range(start + len(site) - 1, len(original)):
    if original[index] == '{':
        depth += 1
    elif original[index] == '}':
        depth -= 1
        if depth == 0:
            end = index + 1
            break
if end is None:
    raise ValueError('Cannot locate the end of the existing Reach site')

replacement = '''reach.zpershuai.top {
    request_body {
        max_size 64KB
    }
    reverse_proxy 127.0.0.1:28787
}'''
candidate = config.with_name('Caddyfile.reach-candidate')
candidate.write_text(original[:start] + replacement + original[end:])
subprocess.run(['caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'], check=True)
timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = config.with_name('Caddyfile.before-reach-' + timestamp)
shutil.copy2(config, backup)
os.replace(candidate, config)
try:
    subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
except subprocess.CalledProcessError:
    shutil.copy2(backup, config)
    subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
    raise
print('Reach proxy switched to 28787; previous config:', backup)
