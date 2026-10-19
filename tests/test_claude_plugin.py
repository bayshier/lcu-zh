"""The Claude Code plugin's SessionStart hook, against a stand-in release and `lcu`.

Nothing here reaches the network, a real LCU installation or Claude Code's configuration:
`curl` and `uname` are replaced on PATH, and the release archive holds a recording installer.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'adapters/claude-plugin'
SCRIPT = PLUGIN / 'scripts/ensure-lcu.sh'
VERSION = '9.9.9'
ARCHIVE = f'lcu-{VERSION}-darwin-arm64.tar.gz'
LATEST = f'https://github.com/amontlabs/lcu/releases/tag/v{VERSION}'

CURL = r'''#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_RECORD/curl.calls"
out= url= head=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -w|--proto|--proto-redir|--max-time) shift 2 ;;
    -I) head=1; shift ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
if [ -n "$head" ]; then
  [ -n "${FAKE_LATEST:-}" ] || exit 6
  printf '%s' "$FAKE_LATEST"
  exit 0
fi
[ -f "$FAKE_ASSETS/${url##*/}" ] || exit 22
cp "$FAKE_ASSETS/${url##*/}" "$out"
'''
UNAME = '''#!/bin/sh
case "$1" in -s) echo "${FAKE_OS:-Darwin}" ;; -m) echo "${FAKE_ARCH:-arm64}" ;; esac
'''
INSTALLER = r'''#!/bin/sh
printf '%s\n' "$*" > "$FAKE_RECORD/install.args"
if [ -n "${FAKE_INSTALL_FAILS:-}" ]; then
  printf 'LCU macOS installer: a "quoted" reason, a back\\slash and a\ttab\n' >&2
  exit 1
fi
mkdir -p "$2/current/bin"
cp "$FAKE_RECORD/lcu" "$2/current/bin/lcu"
'''
LCU = '''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RECORD/lcu.calls"
if [ -n "${FAKE_SETUP_FAILS:-}" ]; then
  echo 'Claude Code: MCP failed: refused' >&2
  exit 1
fi
printf '{"mcpServers": {"lcu": {"type": "stdio"}}}' > "$HOME/.claude.json"
'''
# macOS `plutil -extract KEYPATH json -o /dev/null FILE`, for JSON files on any platform.
PLUTIL = '''#!/usr/bin/env python3
import json, sys
try:
    value = json.load(open(sys.argv[-1]))
    for key in sys.argv[2].split('.'):
        value = value[key]
except Exception:
    sys.exit(1)
'''


def executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)
    return path


@unittest.skipIf(sys.platform == 'win32' or not shutil.which('shasum'), 'POSIX shell hook')
class ClaudePluginHookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.home, self.record, self.assets = root / 'home', root / 'record', root / 'assets'
        self.shims, self.scratch = root / 'shims', root / 'scratch'
        for directory in (self.home, self.record, self.assets, self.scratch):
            directory.mkdir()
        self.app = root / 'ChatGPT.app'
        self.app.mkdir()
        self.state = root / 'data'
        self.prefix = self.home / '.local/share/lcu'
        self.lcu = self.prefix / 'current/bin/lcu'
        executable(self.shims / 'curl', CURL)
        executable(self.shims / 'uname', UNAME)
        executable(self.shims / 'plutil', PLUTIL)
        (self.shims / 'python3').symlink_to(sys.executable)
        executable(self.record / 'lcu', LCU)
        release = root / 'release' / ARCHIVE.removesuffix('.tar.gz')
        executable(release / 'scripts/install.sh', INSTALLER)
        with tarfile.open(self.assets / ARCHIVE, 'w:gz') as bundle:
            bundle.add(release, arcname=release.name)
        digest = hashlib.sha256((self.assets / ARCHIVE).read_bytes()).hexdigest()
        (self.assets / f'{ARCHIVE}.sha256').write_text(f'{digest}  {ARCHIVE}\n')

    def run_hook(self, path=None, **overrides):
        env = {'HOME': str(self.home), 'TMPDIR': str(self.scratch),
               'PATH': path or f'{self.shims}{os.pathsep}/usr/bin{os.pathsep}/bin',
               'CLAUDE_PLUGIN_DATA': str(self.state), 'LCU_APP': str(self.app),
               'FAKE_RECORD': str(self.record), 'FAKE_ASSETS': str(self.assets), 'FAKE_LATEST': LATEST,
               **overrides}
        result = subprocess.run(['/bin/sh', str(SCRIPT)], env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)['systemMessage'] if result.stdout else None

    def recorded(self, name):
        path = self.record / name
        return path.read_text().splitlines() if path.exists() else []

    def assert_nothing_installed(self):
        self.assertEqual(self.recorded('install.args'), [])
        self.assertFalse(self.lcu.exists())
        self.assertFalse((self.state / 'registered').exists())

    def test_manifests_point_at_the_hook(self):
        marketplace = json.loads((ROOT / '.claude-plugin/marketplace.json').read_text())
        entry, = marketplace['plugins']
        self.assertEqual((ROOT / entry['source']).resolve(), PLUGIN)
        self.assertEqual(json.loads((PLUGIN / '.claude-plugin/plugin.json').read_text())['name'], entry['name'])
        group, = json.loads((PLUGIN / 'hooks/hooks.json').read_text())['hooks']['SessionStart']
        self.assertEqual(group['hooks'][0]['command'], 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-lcu.sh"')
        # No MCP entry of its own: registration belongs to `lcu setup`.
        self.assertFalse((PLUGIN / '.mcp.json').exists())

    def test_first_session_installs_the_verified_release_then_registers(self):
        message = self.run_hook()
        self.assertIn(f'LCU {VERSION} was installed and registered for Claude Code', message)
        self.assertIn(f'{self.lcu} doctor', message)
        self.assertEqual(self.recorded('install.args'),
                         [f'--prefix {self.prefix} --existing-app {self.app} --runtime-only'])
        self.assertEqual(self.recorded('lcu.calls'), [f'setup --prefix {self.prefix} --agent claude-code --yes'])
        self.assertEqual((self.state / 'registered').read_text(), f'{self.lcu}\n')
        self.assertFalse((self.state / 'lock').exists())
        self.assertEqual(list(self.scratch.iterdir()), [])
        calls = self.recorded('curl.calls')
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[0].endswith('https://github.com/amontlabs/lcu/releases/latest'))
        self.assertTrue(calls[1].endswith(f'/releases/download/v{VERSION}/{ARCHIVE}'))
        self.assertTrue(all("--proto =https" in call for call in calls))

    def test_later_sessions_do_nothing(self):
        self.run_hook()
        self.assertIsNone(self.run_hook())
        self.assertEqual(len(self.recorded('curl.calls')), 3)
        self.assertEqual(len(self.recorded('lcu.calls')), 1)

    def test_a_registration_removed_from_claude_code_is_restored(self):
        self.run_hook()
        (self.home / '.claude.json').write_text('{"mcpServers": {}}')
        self.assertIn('LCU is registered for Claude Code', self.run_hook())
        self.assertEqual(len(self.recorded('curl.calls')), 3)
        self.assertEqual(len(self.recorded('lcu.calls')), 2)
        self.assertIsNone(self.run_hook())

    def test_a_tilde_app_path_is_expanded(self):
        app = self.home / 'Applications/ChatGPT.app'
        app.mkdir(parents=True)
        self.assertIn('was installed and registered', self.run_hook(LCU_APP='~/Applications/ChatGPT.app'))
        self.assertEqual(self.recorded('install.args'),
                         [f'--prefix {self.prefix} --existing-app {app} --runtime-only'])

    def test_an_existing_installation_is_registered_without_a_download(self):
        shutil.copytree(self.record, self.lcu.parent, ignore=shutil.ignore_patterns('*.calls'))
        self.assertIn('LCU is registered for Claude Code', self.run_hook())
        self.assertEqual(self.recorded('curl.calls'), [])
        self.assertEqual(self.recorded('lcu.calls'), [f'setup --prefix {self.prefix} --agent claude-code --yes'])

    def test_a_custom_prefix_is_installed_and_registered(self):
        prefix = self.home / 'tools/lcu'
        self.run_hook(LCU_PREFIX=str(prefix))
        self.assertEqual(self.recorded('install.args'),
                         [f'--prefix {prefix} --existing-app {self.app} --runtime-only'])
        self.assertEqual((self.state / 'registered').read_text(), f'{prefix}/current/bin/lcu\n')

    def test_an_archive_that_does_not_match_its_checksum_is_not_installed(self):
        for sidecar in ('0' * 64 + f'  {ARCHIVE}\n', 'not a checksum\n', ''):
            with self.subTest(sidecar=sidecar):
                (self.assets / f'{ARCHIVE}.sha256').write_text(sidecar)
                self.assertIn('does not match its published SHA-256', self.run_hook())
                self.assert_nothing_installed()
                self.assertEqual(list(self.scratch.iterdir()), [])

    def test_a_checksum_for_another_file_is_not_accepted(self):
        digest = hashlib.sha256((self.assets / ARCHIVE).read_bytes()).hexdigest()
        (self.assets / f'{ARCHIVE}.sha256').write_text(f'{digest}  another.tar.gz\n')
        self.assertIn('does not match its published SHA-256', self.run_hook())
        self.assert_nothing_installed()

    def test_an_unexpected_latest_release_answer_downloads_nothing(self):
        for latest in ('https://example.com/releases/tag/v1.0.0', f'{LATEST}/../../x',
                       'https://github.com/amontlabs/lcu/releases/tag/v1.0.0;id'):
            with self.subTest(latest=latest):
                self.assertIn('unexpected answer', self.run_hook(FAKE_LATEST=latest))
        self.assertEqual(len(self.recorded('curl.calls')), 3)
        self.assert_nothing_installed()

    def test_network_failures_are_reported_and_retried_next_session(self):
        self.assertIn('could not reach GitHub', self.run_hook(FAKE_LATEST=''))
        (self.assets / ARCHIVE).unlink()
        self.assertIn(f'could not download {ARCHIVE}', self.run_hook())
        self.assert_nothing_installed()
        self.assertFalse((self.state / 'lock').exists())

    def test_a_missing_app_is_reported_before_any_download(self):
        message = self.run_hook(LCU_APP=str(self.app) + '.missing')
        self.assertIn('official ChatGPT desktop app', message)
        self.assertEqual(self.recorded('curl.calls'), [])

    def test_the_hook_needs_no_python(self):
        # LCU 0.10 installs and runs on the app's own Node; the hook looks for no Python.
        hook = (PLUGIN / 'scripts/ensure-lcu.sh').read_text()
        self.assertNotIn('python', hook.lower())

    def test_installer_failure_is_reported_as_valid_json_and_leaves_no_registration(self):
        message = self.run_hook(FAKE_INSTALL_FAILS='1')
        self.assertIn('the LCU installer failed: LCU macOS installer: a "quoted" reason, a back\\slash and a tab',
                      message)
        self.assertIn(str(self.state / 'setup.log'), message)
        self.assertFalse((self.state / 'registered').exists())
        self.assertEqual(self.recorded('lcu.calls'), [])

    def test_failed_registration_is_retried_without_reinstalling(self):
        self.assertIn('registering Claude Code failed: Claude Code: MCP failed: refused',
                      self.run_hook(FAKE_SETUP_FAILS='1'))
        self.assertFalse((self.state / 'registered').exists())
        self.assertIn('LCU is registered for Claude Code', self.run_hook())
        self.assertEqual(len(self.recorded('curl.calls')), 3)
        self.assertEqual(len(self.recorded('lcu.calls')), 2)

    def test_other_platforms_get_one_notice_and_no_action(self):
        for overrides in ({'FAKE_OS': 'Linux', 'FAKE_ARCH': 'x86_64'}, {'FAKE_ARCH': 'x86_64'}):
            with self.subTest(**overrides):
                shutil.rmtree(self.state, ignore_errors=True)
                self.assertIn('Apple Silicon macOS only', self.run_hook(**overrides))
                self.assertIsNone(self.run_hook(**overrides))
        self.assertEqual(self.recorded('curl.calls'), [])

    def test_a_redirected_claude_configuration_gets_one_notice_and_no_action(self):
        shutil.copytree(self.record, self.lcu.parent, ignore=shutil.ignore_patterns('*.calls'))
        redirected = {'CLAUDE_CONFIG_DIR': str(self.home / 'elsewhere')}
        self.assertIn('CLAUDE_CONFIG_DIR is set', self.run_hook(**redirected))
        self.assertIsNone(self.run_hook(**redirected))
        self.assertEqual(self.recorded('lcu.calls'), [])

    def test_a_session_that_finds_another_one_working_leaves_it_alone(self):
        lock = self.state / 'lock'
        lock.mkdir(parents=True)
        self.assertIsNone(self.run_hook())
        self.assertTrue(lock.is_dir())
        self.assert_nothing_installed()
        # A lock older than the hook's timeout was left by a session that died.
        stale = time.time() - 20 * 60
        os.utime(lock, (stale, stale))
        self.assertIn('was installed and registered', self.run_hook())
        self.assertFalse(lock.exists())


if __name__ == '__main__':
    unittest.main()
