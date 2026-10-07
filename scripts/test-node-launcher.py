import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent


class NodeLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='reach-launcher-')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / 'home with spaces'
        self.node = self.home / '.reach/runtime/node/bin/node'
        self.env = dict(os.environ, HOME=str(self.home))
        self.env.pop('REACH_NODE_BIN', None)

    def executable(self, path, identity):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\nprintf "%s\\n" "' + identity + '" "$REACH_NODE_BIN" "$PATH" "$@"\n')
        path.chmod(0o755)

    def launch(self, *args, script='run-node.sh'):
        return subprocess.run(['/bin/sh', str(SCRIPTS / script), *args],
                              env=self.env, capture_output=True, text=True)

    def test_launches_bundled_runtime_with_exact_arguments_and_path(self):
        self.executable(self.node, 'bundled')
        args = ['script with spaces.js', '--option', 'value with spaces']
        result = self.launch(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[:2], ['bundled', str(self.node)])
        self.assertEqual(lines[2].split(os.pathsep)[0], str(self.node.parent))
        self.assertEqual(lines[3:], args)

    def test_honors_explicit_runtime_override(self):
        custom = self.home / 'custom runtime/bin/node'
        self.executable(custom, 'custom')
        self.env['REACH_NODE_BIN'] = str(custom)
        result = self.launch('example.js')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[:2], ['custom', str(custom)])

    def test_missing_runtime_does_not_fall_back_to_system_node(self):
        fallback = self.home / 'system/bin/node'
        self.executable(fallback, 'unexpected-system-node')
        self.env['PATH'] = str(fallback.parent) + os.pathsep + self.env['PATH']
        result = self.launch('example.js')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('Reach Node runtime is missing', result.stderr)

    def test_gateway_entry_uses_same_runtime_without_bash(self):
        self.executable(self.node, 'bundled')
        result = self.launch('--version', script='start-gateway.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = SCRIPTS.parent / 'packages/reach-rpc/dist/gateway-main.js'
        self.assertEqual(result.stdout.splitlines()[3:], [str(expected), '--version'])


if __name__ == '__main__':
    unittest.main()
