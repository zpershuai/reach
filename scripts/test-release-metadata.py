#!/usr/bin/env python3
import importlib.util
import json
import copy
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("release_metadata", Path(__file__).with_name("release-metadata.py"))
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class ReleaseTests(unittest.TestCase):
    def manifest(self, directory, component='engine'):
        for name in metadata.required_assets(component): (directory/name).write_bytes(('fixture-'+name).encode())
        source=metadata.public_source('example/reach-source','a'*40,False)
        return metadata.create_manifest(directory,component,'1.2.3',source,{'rust':'1.96.0','node':'24.21.0','python':'3.14.5'})

    def test_manifest_binds_every_asset_to_public_source_platform_and_exact_toolchain(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); manifest=self.manifest(root)
            self.assertEqual(metadata.validate_manifest(manifest,root),manifest)
            self.assertEqual(manifest['source']['revision'],'a'*40)
            self.assertEqual(len(manifest['platforms']),3)
            self.assertEqual(len((root/'SHA256SUMS').read_text().splitlines()),len(manifest['assets'])+1)
            for change in ['missing','duplicate','extra','private-source','private-field','platform','toolchain','traversal','asset-type']:
                value=copy.deepcopy(manifest)
                if change=='missing': value['assets'].pop()
                if change=='duplicate': value['assets'].append(value['assets'][0])
                if change=='extra': value['assets'].append({'name':'unapproved.env','bytes':1,'sha256':'a'*64})
                if change=='private-source': value['source']['url']='file:///private/inventory'
                if change=='private-field': value['privateRevision']='b'*40
                if change=='platform': value['platforms'].pop()
                if change=='toolchain': value['toolchain']['rust']='stable'
                if change=='traversal': value['assets'][0]['name']='../outside'
                if change=='asset-type': value['assets'][0]['sha256']=None
                with self.subTest(change=change), self.assertRaises(ValueError): metadata.validate_manifest(value)
            (root/'engine-darwin-x64.NOTICES.txt').write_bytes(b'tampered')
            with self.assertRaises(ValueError): metadata.validate_manifest(manifest,root)

    def test_generation_rejects_missing_extra_and_symlinked_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); self.manifest(root,'gateway')
            source=metadata.public_source('example/reach-source','a'*40,False); tools={'rust':'1.96.0','node':'24.21.0','python':'3.14.5'}
            (root/'unapproved.txt').write_text('fixture')
            with self.assertRaises(ValueError): metadata.create_manifest(root,'gateway','1.2.3',source,tools)
            (root/'unapproved.txt').unlink(); (root/'LICENSE').unlink()
            with self.assertRaises(ValueError): metadata.create_manifest(root,'gateway','1.2.3',source,tools)
            (root/'LICENSE').symlink_to(root/'THIRD_PARTY_NOTICES.txt')
            with self.assertRaises(ValueError): metadata.create_manifest(root,'gateway','1.2.3',source,tools)

    def test_public_source_requires_anonymous_visibility_and_an_exact_commit(self):
        with patch.object(metadata,'download',side_effect=[b'{"private":false}',json.dumps({'sha':'a'*40}).encode()]):
            self.assertEqual(metadata.public_source('example/reach-source','a'*40)['revision'],'a'*40)
        with patch.object(metadata,'download',side_effect=[b'{"private":true}',json.dumps({'sha':'a'*40}).encode()]):
            with self.assertRaises(ValueError): metadata.public_source('example/reach-source','a'*40)
        with patch.object(metadata,'download',side_effect=[b'{"private":false}',json.dumps({'sha':'b'*40}).encode()]):
            with self.assertRaises(ValueError): metadata.public_source('example/reach-source','a'*40)
        with self.assertRaises(ValueError): metadata.checksums(Path('.'),['LICENSE','LICENSE'])
    def test_tag_version_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "packages/reach-rpc").mkdir(parents=True)
            (root / "packages/reach-rpc/package.json").write_text(json.dumps({"version": "0.3.1"}))
            self.assertEqual(metadata.parse_tag("gateway-v0.3.1", root), ("gateway", "0.3.1"))
            for tag in ["gateway-v0.3.2", "gateway-v00.3.1", "gateway-v0.3.1-rc.1", "arbitrary"]:
                with self.assertRaises(ValueError):
                    metadata.parse_tag(tag, root)

    def test_required_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                metadata.checksums(root, ["engine-darwin-x64"])
            (root / "engine-darwin-x64").write_bytes(b"fixture")
            metadata.checksums(root, ["engine-darwin-x64"])
            self.assertIn("engine-darwin-x64", (root / "SHA256SUMS").read_text())

    def test_public_notes_do_not_copy_even_unmarked_private_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], text=True)
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (root / "packages/reach-rpc").mkdir(parents=True)
            manifest = root / "packages/reach-rpc/package.json"
            manifest.write_text(json.dumps({"version": "0.3.0"}))
            git("add", ".")
            git("commit", "-qm", "old component change")
            git("tag", "gateway-v0.3.0")
            manifest.write_text(json.dumps({"version": "0.3.1"}))
            git("add", ".")
            git("commit", "-qm", "fix: retain useful commit", "-m", "ssh fixture@host.example.invalid\n.reach/inventory\ngateway.env credentials\nUseful public detail")
            git("tag", "engine-v0.2.1")
            git("tag", "gateway-v0.3.1")
            notes = metadata.release_notes("gateway-v0.3.1", root)
            self.assertNotIn("retain useful commit", notes)
            self.assertNotIn("Useful public detail", notes)
            self.assertNotIn("old component change", notes)
            for private in ["fixture@", ".reach/", "gateway.env"]:
                self.assertNotIn(private, notes)


if __name__ == "__main__":
    unittest.main()
