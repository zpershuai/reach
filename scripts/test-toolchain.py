#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('toolchain', Path(__file__).with_name('verify-toolchain.py'))
toolchain = importlib.util.module_from_spec(spec); spec.loader.exec_module(toolchain)
ROOT = toolchain.ROOT


class ToolchainTests(unittest.TestCase):
    def test_tool_drift_is_reported_before_build(self):
        expected = json.loads((ROOT / 'scripts/toolchain.json').read_text())
        for name in expected:
            observed = dict(expected, **{name: '0.0.0'})
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'TOOLCHAIN_VERSION_MISMATCH: ' + name):
                toolchain.check(expected, observed)
        self.assertEqual(toolchain.check(expected, expected), expected)

    def test_cargo_refuses_a_drifted_lock_in_an_isolated_copy(self):
        # A dependency-free crate keeps this hermetic: it must not depend on a warm registry cache.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'src').mkdir()
            (root / 'src/lib.rs').write_text('')
            manifest = '[package]\nname = "lock-fixture"\nversion = "{}"\nedition = "2021"\n'
            (root / 'Cargo.toml').write_text(manifest.format('1.0.0'))
            (root / 'Cargo.lock').write_text('version = 4\n\n[[package]]\nname = "lock-fixture"\nversion = "1.0.0"\n')
            command = ['cargo', 'metadata', '--locked', '--offline', '--format-version=1']
            env = dict(os.environ, CARGO_HOME=str(root / 'cargo-home'))
            self.assertEqual(subprocess.run(command, cwd=root, capture_output=True, text=True, env=env).returncode, 0)
            (root / 'Cargo.toml').write_text(manifest.format('99.99.99'))
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('lock file', result.stderr)

    def test_npm_manifest_lock_drift_is_rejected_before_any_dependency_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copyfile(ROOT / 'package.json', root / 'package.json')
            shutil.copyfile(ROOT / 'package-lock.json', root / 'package-lock.json')
            toolchain.check_npm_lock(root)
            lock = json.loads((root / 'package-lock.json').read_text())
            lock['packages']['']['devDependencies']['@fission-ai/openspec'] = '0.0.0'
            (root / 'package-lock.json').write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'NPM_LOCK_DRIFT: devDependencies'):
                toolchain.check_npm_lock(root)


if __name__ == '__main__': unittest.main()
