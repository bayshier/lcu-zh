#!/usr/bin/env bash
# Run inside the disposable Ubuntu test image with --network none. The official app is
# mounted read-only at two different version folders (/opt/silo/chatgpt/<version>), as a
# system or shared install would be; LCU must validate and use it in place.
set -euo pipefail
archive=${1:?Provide the thin LCU archive}
first=${2:?Provide the first read-only app path}
second=${3:?Provide the second read-only app path (a different version folder)}
cd "$(dirname -- "$archive")"
name=$(basename -- "$archive")
sha256sum -c "$name.sha256"
python3 -c 'from pathlib import Path; assert {p.name for p in Path("/sys/class/net").iterdir()} == {"lo"}, "Test requires --network none"'
for app in "$first" "$second"; do
  if touch "$app/.lcu-write-probe" 2>/dev/null; then
    echo "App mount is writable: $app" >&2
    exit 1
  fi
done
test "$first" != "$second"
tar -xzf "$name" -C /opt
bundle="/opt/${name%.tar.gz}"
useradd --create-home lcutester

selected() {
  python3 - "$1" <<'PY'
import json, os, sys
from pathlib import Path
prefix = Path('/opt/lcu')
expected = Path(sys.argv[1]).resolve(strict=True)
release = (prefix / 'current').resolve(strict=True)
descriptor = json.loads((release / 'installation.json').read_text())
assert Path(descriptor['app']) == expected, (descriptor['app'], expected)
assert os.readlink(release / 'app') == str(expected)
assert (release / 'app').resolve() == expected
assert not (prefix / 'apps').exists(), 'installer copied the application'
print(f"Selected {descriptor['package_version']}; CUA {descriptor['runtime']}; read-only at {expected}")
PY
}

"$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --skip-system --existing-app "$first" --offline --yes
selected "$first"
first_release=$(readlink -f /opt/lcu/current)
runuser -u lcutester -- /opt/lcu/current/bin/lcu status --json >/tmp/lcu-status-first.json
python3 - "$first" <<'PY'
import json, sys
from pathlib import Path
status = json.load(open('/tmp/lcu-status-first.json'))
assert Path(status['app']['path']).resolve() == Path(sys.argv[1]).resolve(), status['app']
assert status['changed_since_install'] is None, status['changed_since_install']
PY
# A native action through the original runtime, run by the unprivileged account.
runuser -u lcutester -- dbus-run-session -- bash /src/tests/desktop.sh

# The same app now appears at a different version folder. Reinstalling must follow it.
"$bundle/scripts/install.sh" --prefix /opt/lcu --user lcutester \
  --runtime-only --skip-system --existing-app "$second" --offline --yes
selected "$second"
test "$(readlink -f /opt/lcu/current)" != "$first_release"
runuser -u lcutester -- /opt/lcu/current/bin/lcu status --json >/tmp/lcu-status-second.json
python3 - "$second" <<'PY'
import json, sys
from pathlib import Path
status = json.load(open('/tmp/lcu-status-second.json'))
assert Path(status['app']['path']).resolve() == Path(sys.argv[1]).resolve(), status['app']
PY
runuser -u lcutester -- dbus-run-session -- bash /src/tests/desktop.sh
# Pruning the first release must not touch either read-only app.
/opt/lcu/current/bin/lcu prune --keep 1 --yes
test -d "$first" && test -d "$second"
test ! -e /opt/lcu/apps
