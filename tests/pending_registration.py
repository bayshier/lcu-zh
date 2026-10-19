"""Run as root in the disposable container: harnesses installed after setup are registered by --reconcile."""
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tomllib

prefix = Path('/opt/lcu')
command = str(prefix / 'current/bin/lcu')
account = 'lcupending'
subprocess.run(['useradd', '--create-home', account], check=True)
home = Path(pwd.getpwnam(account).pw_dir)
# Pi is installed system-wide in the image; the account's PATH hides it until it is "installed" below.
env = {'HOME': str(home), 'USER': account, 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}


def lcu(*args, check=True):
    return subprocess.run(['/usr/sbin/runuser', '-u', account, '--', command, *args], env=env, check=check,
                          capture_output=True, text=True)


state_path = home / '.local/state/lcu/setup.json'
settings = home / '.pi/agent/settings.json'

first = lcu('setup', '--agent', 'all', '--allow-missing', '--session', 'direct', '--yes', '--approval', 'auto')
assert 'Pi: not installed; will register when it appears' in first.stdout, first.stdout
assert 'Pending (not installed): pi, omp, hermes.' in first.stdout, first.stdout
state = json.loads(state_path.read_text())
assert (state['approval'], state['pending']) == ('auto', ['pi', 'omp', 'hermes']), state
assert not settings.exists(), 'Pi must not be registered before it is installed'
# Codex and Claude Code register without their CLIs, with the approval mode applied.
registered = tomllib.loads((home / '.codex/config.toml').read_text())['mcp_servers']['lcu']
assert registered['tools']['js']['approval_mode'] == 'approve', registered
assert 'default_tools_approval_mode' not in registered, registered
assert 'lcu' in json.loads((home / '.claude.json').read_text())['mcpServers']
allowed = json.loads((home / '.claude/settings.json').read_text())['permissions']['allow']
assert 'mcp__lcu__js' in allowed and 'mcp__lcu__js_reset' in allowed and 'mcp__lcu' not in allowed, allowed
status = json.loads(lcu('status', '--json').stdout)
assert status['pending'] == ['pi', 'omp', 'hermes'], status

# Nothing installed: reconcile is silent and changes nothing.
before = state_path.read_bytes()
quiet = lcu('setup', '--reconcile')
assert (quiet.stdout, quiet.stderr) == ('', ''), quiet
assert state_path.read_bytes() == before and not settings.exists()

# Install the real Pi, as a user would, then reconcile.
(home / '.local/bin').mkdir(parents=True)
shutil.copy('/usr/local/bin/pi', home / '.local/bin/pi')
os.chmod(home / '.local/bin/pi', 0o755)
shutil.chown(home / '.local/bin', account, account)
shutil.chown(home / '.local/bin/pi', account, account)
done = lcu('setup', '--reconcile')
assert 'Registered: pi' in done.stdout, done
packages = json.loads(settings.read_text())['packages']
extension = home / '.local/share/lcu/pi/extension.mjs'
assert any((settings.parent / item).resolve() == extension.resolve() for item in packages if isinstance(item, str)), packages
assert json.loads((home / '.local/share/lcu/pi/commands.json').read_text())['user'] == [command]
state = json.loads(state_path.read_text())
assert (state['approval'], state['pending']) == ('auto', ['omp', 'hermes']), state
assert json.loads(lcu('status', '--json').stdout)['pending'] == ['omp', 'hermes']

# Idempotent: the next run is a silent no-op.
settled = state_path.read_bytes()
again = lcu('setup', '--reconcile')
assert (again.stdout, again.stderr) == ('', ''), again
assert state_path.read_bytes() == settled
print('pending registration: allow-missing, no-op reconcile and reconcile after a later Pi install passed')
