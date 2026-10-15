#!/usr/bin/env python3
import hashlib
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('apply_release', Path(__file__).with_name('apply-release.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

FAKE_DOCKER = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['DOCKER_LOG'], 'a') as output: output.write(json.dumps(args)+'\\n')
if args[0] == 'pull' and os.environ.get('PULL_FAIL') == '1': sys.exit(1)
if args[:2] == ['image','inspect']:
    if '--format' in args:
        fmt=args[args.index('--format')+1]
        if 'RepoDigests' in fmt: print(json.dumps([os.environ['EXPECTED_IMAGE']]))
        elif 'Config.User' in fmt: print('1000')
if args[0] == 'run': print(os.environ.get('REPORTED_VERSION', '0.3.2'))
if args[0] == 'compose':
    if 'config' in args: print(json.dumps({'services':{'engine': {'image':'example/engine:installed','env_file':['engine.env'],'volumes':['./workspace:/workspace']}}}))
    else:
        base = Path(args[args.index('-f')+1])
        assert 'engine.env' in base.read_text() or 'gateway.env' in base.read_text()
        assert 'workspace' in base.read_text() or 'engines.json' in base.read_text()
        if args.count('-f') == 2:
            override=Path(args[args.index('-f',args.index('-f')+1)+1])
            value=json.loads(override.read_text())
            assert set(value['services']['engine']) == {'image'}
        if os.environ.get('UP_FAIL') == '1': sys.exit(1)
'''


class Downloads:
    def __init__(self, assets): self.assets = assets
    def asset(self, name):
        if name not in self.assets: raise helper.MissingAsset(name)
        return self.assets[name]


class HelperTests(unittest.TestCase):
    def test_gateway_compose_keeps_hardening_and_mounts_persistent_data(self):
        repo = Path(__file__).resolve().parent.parent
        compose = (repo/'deploy/compose.yaml').read_text()
        for required in ['read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', './data:/var/lib/reach:rw', 'REACH_DATA_DIR: /var/lib/reach']:
            self.assertIn(required, compose)
        self.assertIn('chown node:node /var/lib/reach', (repo/'deploy/Dockerfile.gateway').read_text())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root/'deploy').mkdir()
        (self.root/'deploy/compose.yaml').write_text('services:\n  gateway:\n    env_file: gateway.env\n    volumes: ["./engines.json:/registry"]\n  engine:\n    env_file: engine.env\n    volumes: ["./workspace:/workspace"]\n')
        (self.root/'deploy/gateway.env').write_text('local fixture credentials')
        (self.root/'deploy/engines.json').write_text('local registry')
        (self.root/'deploy/engine.env').write_text('engine credentials')
        (self.root/'deploy/data').mkdir(mode=0o700)
        for name in ['reach.db', 'reach.db-wal', 'reach.db-shm']:
            (self.root/'deploy/data'/name).write_bytes(b'local persistent state')
        self.original_compose = (self.root/'deploy/compose.yaml').read_bytes()
        (self.root/'docker').write_text(FAKE_DOCKER)
        (self.root/'docker').chmod(0o755)
        self.log = self.root/'docker.log'
        self.requests = self.root/'update'
        self.requests.mkdir()
        self.ack_enabled = True
        self.stop_ack = threading.Event()
        self.ack_thread = threading.Thread(target=self.acknowledge, daemon=True)
        self.ack_thread.start()
        self.addCleanup(self.stop_acknowledging)
        image = 'ghcr.io/example/reach-gateway@sha256:'+'b'*64
        env = {'PATH': str(self.root)+os.pathsep+os.environ['PATH'], 'DOCKER_LOG': str(self.log), 'EXPECTED_IMAGE':image}
        self.environment = patch.dict(os.environ, env)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.request = {'component':'gateway','version':'0.3.2','asset':'gateway-amd64.tgz','digest':'a'*64,'repo':'example/reach'}
        self.image_bytes = (image+'\n').encode()

    def stop_acknowledging(self):
        self.stop_ack.set()
        self.ack_thread.join(timeout=1)

    def acknowledge(self):
        while not self.stop_ack.wait(0.01):
            if not self.ack_enabled: continue
            try:
                intent=json.loads((self.requests/'apply.json').read_text())
                acknowledgement={key:intent[key] for key in ['component','version','nonce']}
                (self.requests/'idle.json').write_text(json.dumps(acknowledgement))
            except (FileNotFoundError,ValueError): pass

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def image_assets(self):
        return Downloads({'gateway-image.txt':self.image_bytes, 'SHA256SUMS': (hashlib.sha256(self.image_bytes).hexdigest()+'  gateway-image.txt\n').encode()})

    def archive(self, files=None):
        output = io.BytesIO()
        payload = files or {'packages/reach-rpc/dist/gateway-main.js':b'fixture', 'packages/reach-rpc/package.json':b'{}', 'packages/reach-rpc/package-lock.json':b'{}', 'deploy/Dockerfile.gateway':b'FROM fixture', 'deploy/compose.yaml':b'NEW DEFAULT', 'deploy/gateway.env':b'overwrite', 'deploy/engines.json':b'overwrite'}
        payload.setdefault('deploy/data/reach.db', b'archive must not replace local state')
        with tarfile.open(fileobj=output,mode='w:gz') as archive:
            for name,data in payload.items():
                member=tarfile.TarInfo(name); member.size=len(data); archive.addfile(member,io.BytesIO(data))
        return output.getvalue()

    def assert_preserved(self):
        self.assertEqual((self.root/'deploy/gateway.env').read_text(), 'local fixture credentials')
        self.assertEqual((self.root/'deploy/engines.json').read_text(), 'local registry')
        self.assertEqual((self.root/'deploy/compose.yaml').read_bytes(), self.original_compose)
        for name in ['reach.db', 'reach.db-wal', 'reach.db-shm']:
            self.assertEqual((self.root/'deploy/data'/name).read_bytes(), b'local persistent state')
        self.assertEqual((self.root/'deploy/data').stat().st_mode & 0o777, 0o700)

    def test_pull_verifies_digest_version_and_keeps_previous(self):
        helper.apply_gateway(self.request,self.root,self.image_assets(),self.requests)
        calls=self.calls()
        self.assertIn(['pull','ghcr.io/example/reach-gateway:0.3.2'],calls)
        self.assertIn(['tag','reach-gateway:current','reach-gateway:previous'],calls)
        self.assertTrue(any(c[0]=='compose' and c[-1]=='gateway' for c in calls))
        self.assert_preserved()

    def test_tarball_fallback_preserves_env_and_compose(self):
        archive=self.archive(); self.request['digest']=hashlib.sha256(archive).hexdigest()
        with patch.dict(os.environ, {'PULL_FAIL':'1'}):
            assets=self.image_assets(); assets.assets['gateway-amd64.tgz']=archive
            helper.apply_gateway(self.request,self.root,assets,self.requests)
        self.assertTrue(any(c[0]=='build' for c in self.calls()))
        self.assertEqual((self.root/'packages/reach-rpc/dist/gateway-main.js').read_bytes(),b'fixture')
        self.assert_preserved()

    def test_digest_mismatch_leaves_install_untouched(self):
        with self.assertRaises(ValueError): helper.apply_gateway(self.request,self.root,Downloads({'gateway-amd64.tgz':self.archive()}),self.requests)
        self.assertFalse(any(c[0] in ['build','tag','compose'] for c in self.calls()))
        self.assert_preserved()

    def test_image_digest_and_version_mismatch_never_retag(self):
        for env in [{'EXPECTED_IMAGE':'ghcr.io/example/reach-gateway@sha256:'+'c'*64}, {'REPORTED_VERSION':'0.3.1'}]:
            self.log.write_text('')
            with patch.dict(os.environ,env), self.assertRaises(ValueError): helper.apply_gateway(self.request,self.root,self.image_assets(),self.requests)
            self.assertFalse(any(c[0] in ['tag','compose'] for c in self.calls()))

    def test_failed_recreate_restores_previous_image(self):
        with patch.dict(os.environ,{'UP_FAIL':'1'}), self.assertRaises(Exception): helper.apply_gateway(self.request,self.root,self.image_assets(),self.requests)
        self.assertIn(['tag','reach-gateway:previous','reach-gateway:current'],self.calls())

    def test_engine_keeps_env_and_workspace_mounts(self):
        request=dict(self.request,component='engine',version='0.2.2',asset='engine-linux-x64-musl')
        data=b'engine fixture'; request['digest']=hashlib.sha256(data).hexdigest()
        with patch.dict(os.environ,{'REPORTED_VERSION':'0.2.2'}): helper.apply_engine(request,self.root,Downloads({request['asset']:data}),self.requests)
        self.assertEqual((self.root/'deploy/engine.env').read_text(),'engine credentials')
        self.assert_preserved()
        calls=self.calls()
        self.assertTrue(any(c[0]=='compose' and c[-1]=='engine' and c.count('-f')==2 for c in calls))

    def test_archive_rejects_traversal(self):
        archive=self.root/'bad.tgz'; archive.write_bytes(self.archive({'../gateway.env':b'bad'}))
        with self.assertRaises(ValueError): helper.safe_extract(archive,self.root/'extracted')

    def test_prepares_before_idle_then_recreates_only_after_ack(self):
        self.ack_enabled = False
        errors=[]
        def apply():
            try: helper.apply_gateway(self.request,self.root,self.image_assets(),self.requests)
            except Exception as error: errors.append(error)
        worker=threading.Thread(target=apply)
        worker.start()
        try:
            for _ in range(300):
                if (self.requests/'apply.json').exists(): break
                time.sleep(0.01)
            self.assertTrue((self.requests/'apply.json').exists())
            self.assertTrue(any(c[0]=='run' for c in self.calls()))
            self.assertFalse(any(c[0]=='tag' or c[0]=='compose' for c in self.calls()))
            # A stale acknowledgement from a different attempt must not apply.
            (self.requests/'idle.json').write_text(json.dumps({'component':'gateway','version':'0.3.2','nonce':'stale'}))
            time.sleep(0.15)
            self.assertFalse(any(c[0]=='compose' for c in self.calls()))
            self.ack_enabled=True
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors,[])
            self.assertTrue(any(c[0]=='compose' for c in self.calls()))
            self.assertFalse((self.requests/'apply.json').exists())
        finally:
            self.ack_enabled=True
            worker.join(timeout=5)

    def test_idle_timeout_does_not_recreate_and_releases_admission(self):
        self.ack_enabled=False
        with self.assertRaises(TimeoutError):
            with helper.idle_admission(self.request,self.requests,timeout=0.05):
                self.fail('cannot apply without acknowledgement')
        self.assertFalse((self.requests/'apply.json').exists())
        self.assertFalse((self.requests/'idle.json').exists())
        self.assertEqual(self.calls(),[])

    def test_engine_prepares_but_does_not_recreate_without_idle_ack(self):
        self.ack_enabled=False
        request=dict(self.request,component='engine',version='0.2.2',asset='engine-linux-x64-musl')
        data=b'engine fixture'; request['digest']=hashlib.sha256(data).hexdigest()
        original=helper.idle_admission
        def short_wait(request,directory): return original(request,directory,timeout=0.05)
        with patch.dict(os.environ,{'REPORTED_VERSION':'0.2.2'}), patch.object(helper,'idle_admission',short_wait), self.assertRaises(TimeoutError):
            helper.apply_engine(request,self.root,Downloads({request['asset']:data}),self.requests)
        self.assertTrue(any(c[0]=='build' for c in self.calls()))
        self.assertFalse(any(c[0]=='tag' or (c[0]=='compose' and 'up' in c) for c in self.calls()))
        self.assertFalse((self.requests/'apply.json').exists())
        self.assert_preserved()

    def test_result_and_request_lifecycle(self):
        directory=self.requests
        (directory/'request.json').write_text(json.dumps(self.request))
        with patch.object(helper,'ReleaseDownloads',return_value=self.image_assets()): helper.apply_request('gateway',directory,self.root)
        self.assertFalse((directory/'request.json').exists())
        self.assertEqual(json.loads((directory/'result.json').read_text())['ok'],True)


if __name__=='__main__': unittest.main()
