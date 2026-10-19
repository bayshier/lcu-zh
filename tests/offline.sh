#!/usr/bin/env bash
# Run inside the disposable Ubuntu test image with --network none.
set -euo pipefail
archive=${1:?Provide the thin LCU archive}
package=${2:?Provide the pinned official ChatGPT package}
cd "$(dirname -- "$archive")"
name=$(basename -- "$archive")
sha256sum -c "$name.sha256"
python3 -c 'from pathlib import Path; assert {p.name for p in Path("/sys/class/net").iterdir()} == {"lo"}, "Test requires --network none"'
python3 - "$package" /src/runtime.lock.json /src/tested-versions.json <<'PY'
import hashlib, json, platform, sys
from pathlib import Path
arch = {'aarch64': 'arm64', 'x86_64': 'x64'}[platform.machine()]
lock = json.loads(Path(sys.argv[2]).read_text())
recorded = json.loads(Path(sys.argv[3]).read_text())['entries']
# The package is the pinned development input, or a Linux package whose pair is
# recorded as tested for this architecture.
accepted = {lock['architectures'][arch]['sha256']} | {
    e['app_sha256'] for e in recorded
    if e['platform'] == 'linux' and e['architecture'] == arch and 'app_sha256' in e}
with open(sys.argv[1], 'rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() in accepted
PY
tar -xzf "$name" -C /opt
bundle="/opt/${name%.tar.gz}"
dpkg-deb --extract "$package" /tmp/lcu-offline-app
app=/tmp/lcu-offline-app/usr/lib/chatgpt
useradd --create-home lcutester
"$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --skip-system --existing-app "$app" --offline --yes
# A package input is rejected and cannot change the already selected release.
selected=$(readlink -f /opt/lcu/current)
printf 'corrupt package' >/tmp/corrupt-chatgpt.deb
if "$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --skip-system --app-package /tmp/corrupt-chatgpt.deb --offline --yes \
  >/tmp/lcu-install-failure.log 2>&1; then
  echo 'Installer accepted an application package instead of requiring an installed app' >&2
  exit 1
fi
test "$(readlink -f /opt/lcu/current)" = "$selected"

# A system-library acquisition failure in a separate installer process must
# leave the selected release usable. Shadow apt-get only inside this command;
# the disposable test image and host package manager remain unchanged.
mkdir /tmp/lcu-failing-apt
cat >/tmp/lcu-failing-apt/apt-get <<'SH'
#!/bin/sh
printf '%s\n' "$*" >/tmp/lcu-apt-invoked
exit 100
SH
chmod +x /tmp/lcu-failing-apt/apt-get
if PATH="/tmp/lcu-failing-apt:$PATH" "$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --existing-app "$app" --yes \
  >/tmp/lcu-apt-failure.log 2>&1; then
  echo 'Installer selected a release after system-library acquisition failed' >&2
  exit 1
fi
test "$(cat /tmp/lcu-apt-invoked)" = update
test "$(readlink -f /opt/lcu/current)" = "$selected"
test -f "$selected/bin/lcu"

# Exercise separate installer processes racing on the same prefix. Both
# link the same installed app in place.
"$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --skip-system --existing-app "$app" --offline --yes \
  >/tmp/lcu-install-a.log 2>&1 &
first=$!
"$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --skip-system --existing-app "$app" --offline --yes \
  >/tmp/lcu-install-b.log 2>&1 &
second=$!
status=0
wait "$first" || status=$?
wait "$second" || status=$?
if [[ $status -ne 0 ]]; then
  cat /tmp/lcu-install-a.log /tmp/lcu-install-b.log >&2
  exit "$status"
fi
python3 - /opt/lcu /package.deb <<'PY'
import hashlib, json, os, platform, stat, subprocess
from pathlib import Path
import sys
sys.path.insert(0, '/src/scripts')
from bundle import architecture

prefix = Path('/opt/lcu')
current = prefix / 'current'
assert current.is_symlink(), 'current is not a symlink'
release = current.resolve(strict=True)
assert release.parent == (prefix / 'releases').resolve()
manifest = json.loads((release / 'bundle.json').read_text())
assert manifest['architecture'] == architecture()
descriptor = json.loads((release / 'installation.json').read_text())
application = (release / descriptor['app']).resolve(strict=True)
assert application.is_dir()
package_version = subprocess.run(
    ['dpkg-deb', '-f', sys.argv[2], 'Version'], check=True,
    capture_output=True, text=True).stdout.strip()
assert descriptor['package_version'] == package_version, 'selected app version differs from the local DEB'
runtime_manifest = json.loads((application / 'resources/cua_node/manifest.json').read_text())
assert descriptor['runtime'] == runtime_manifest['runtime_archive_version'], 'selected runtime metadata differs from the app'
assert application == Path('/tmp/lcu-offline-app/usr/lib/chatgpt'), 'release does not use the installed app in place'
assert os.readlink(release / 'app') == descriptor['app'] == str(application)
assert 'sha256' not in descriptor
assert not (prefix / 'apps').exists(), 'installer copied the application'
actual = {}
for path in sorted(release.rglob('*')):
    relative = path.relative_to(release).as_posix()
    if relative in {'bundle.json', 'installation.json', 'app', 'node-path'}:
        continue
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode):
        target = os.readlink(path)
        resolved = path.resolve()
        assert not Path(target).is_absolute() and (resolved.is_relative_to(release) or resolved.is_relative_to(application)), f'unsafe release symlink: {relative} -> {target}'
        actual[relative] = {'type': 'symlink', 'target': target}
    elif stat.S_ISREG(mode):
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        actual[relative] = {'type': 'file', 'sha256': digest, 'mode': mode & 0o777}
    elif not stat.S_ISDIR(mode):
        raise AssertionError(f'unsupported release entry: {relative}')
assert actual == manifest['files'], 'selected release does not match its bundle manifest'
assert (application / 'resources/cua_node/manifest.json').is_file()
print(f"Selected ChatGPT {descriptor['package_version']}; CUA {descriptor['runtime']}; in place at {application}")
PY
test ! -e /opt/lcu/.next
test -z "$(find /opt/lcu/releases -maxdepth 1 -name '.build-*' -print -quit)"
test ! -e /opt/lcu/apps
test ! -e /opt/lcu/cache

# LCU needs no Python. Hide every python3 in this disposable container behind a shim that records the call
# and fails, then reinstall and run the installed commands. Python returns afterwards for the test drivers.
python_bins=$(find /usr/bin /usr/local/bin -maxdepth 1 -name 'python3*' \( -type f -o -type l \) -print)
restore_python() {
  for path in $python_bins; do
    if [[ -e "$path.lcu-hidden" || -L "$path.lcu-hidden" ]]; then mv -f "$path.lcu-hidden" "$path"; fi
  done
}
trap restore_python EXIT
for path in $python_bins; do
  mv "$path" "$path.lcu-hidden"
  printf '#!/bin/sh\necho "python called: $0 $*" >>/tmp/lcu-python-called\nexit 127\n' >"$path"
  chmod 755 "$path"
done
if python3 -c pass 2>/dev/null; then echo 'python3 is still usable' >&2; exit 1; fi
rm -f /tmp/lcu-python-called
"$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --skip-system --existing-app "$app" --offline --yes
runuser -u lcutester -- /opt/lcu/current/bin/lcu --version
runuser -u lcutester -- /opt/lcu/current/bin/lcu status --json >/dev/null
runuser -u lcutester -- /opt/lcu/current/bin/lcu-session --help >/dev/null
runuser -u lcutester -- /opt/lcu/current/bin/lcu-codex-sandbox --help >/dev/null 2>&1 || true
runuser -u lcutester -- /opt/lcu/current/bin/lcu doctor --non-interactive >/dev/null 2>&1 || true
/opt/lcu/current/bin/lcu setup --user lcutester --export /home/lcutester/no-python-export --session direct --yes
rm -rf /home/lcutester/no-python-export
if [[ -e /tmp/lcu-python-called ]]; then
  echo 'LCU called Python:' >&2
  cat /tmp/lcu-python-called >&2
  exit 1
fi
restore_python
trap - EXIT

python3 -m unittest discover -b -s /src/tests -p 'test_*.py' -q
python3 /src/tests/registration.py
python3 /src/tests/pending_registration.py
runuser -u lcutester -- dbus-run-session -- bash /src/tests/desktop.sh
