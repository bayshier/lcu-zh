"""The build's Python seal and the installer's Node verify agree on the release inventory."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from bundle import VERSION, seal

NODE = shutil.which('node')
VERIFY = ('const { verify } = await import(process.argv[1]); '
          'try { verify(process.argv[2], process.argv[3], process.argv[4]); } '
          'catch (error) { console.error(error.message); process.exit(3); }')


@unittest.skipIf(NODE is None, 'Node is required to check scripts/bundle.mjs')
class SealVerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'bundle'
        (self.root / 'runtime/bin').mkdir(parents=True)
        self.binary = self.root / 'runtime/bin/node'
        self.binary.write_bytes(b'fixture binary')
        self.binary.chmod(0o755)
        (self.root / 'runtime/bin/alias').symlink_to('node')
        (self.root / 'docs').mkdir()
        (self.root / 'docs/nötes.md').write_text('unicode name')

    def verify(self, target='linux', arch='arm64'):
        return subprocess.run([NODE, '--input-type=module', '-e', VERIFY, (SCRIPTS / 'bundle.mjs').as_uri(),
                               str(self.root), arch, target], capture_output=True, text=True).returncode

    def test_version_has_one_source(self):
        self.assertRegex((SCRIPTS / 'bundle.mjs').read_text(), f"export const VERSION = '{VERSION}';")

    def test_python_seal_verifies_in_node_and_tampering_is_caught(self):
        seal(self.root, 'arm64')
        self.assertEqual(json.loads((self.root / 'bundle.json').read_text())['version'], VERSION)
        self.assertEqual(self.verify(), 0)
        self.assertEqual(self.verify(arch='x64'), 3)
        if os.name != 'nt':
            # POSIX execute bits are part of a POSIX seal. A Windows host has none to change (both Python and Node
            # report 0o666 whatever chmod set), and installers only verify a Linux or macOS seal on that platform.
            self.binary.chmod(0o644)
            self.assertEqual(self.verify(), 3)
            self.binary.chmod(0o755)
            self.assertEqual(self.verify(), 0)
        self.binary.write_bytes(b'tampered binary')
        self.assertEqual(self.verify(), 3)

    def test_windows_seal_ignores_modes_but_catches_tampering(self):
        seal(self.root, 'x64', 'windows')
        self.binary.chmod(0o600)
        self.assertEqual(self.verify('windows', 'x64'), 0)
        self.binary.write_bytes(b'tampered binary')
        self.assertEqual(self.verify('windows', 'x64'), 3)


if __name__ == '__main__':
    unittest.main()
