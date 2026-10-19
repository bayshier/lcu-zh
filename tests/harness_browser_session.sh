#!/usr/bin/env bash
set -euo pipefail
test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
release=${LCU_BROWSER_RELEASE:?Browser fixture needs an installed LCU release}
[[ "$(id -u)" != 0 ]] || { echo 'Run this as browser-test inside the disposable container.' >&2; exit 2; }
[[ -x "$release/bin/lcu" && -x "$release/app/resources/cua_node/bin/node" ]] || {
  echo "Installed LCU release is incomplete: $release" >&2; exit 2;
}
[[ "${LCU_BROWSER_KIND:-}" == chrome ]] || { echo 'This acceptance fixture requires official Chrome.' >&2; exit 2; }

"$release/bin/lcu" setup --prefix "$LCU_BROWSER_PREFIX" --export "$HOME/lcu-browser-export" --session direct --chrome --yes
manifest="$HOME/.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json"
[[ -f "$manifest" ]] || { echo "LCU native-host manifest missing: $manifest" >&2; exit 1; }
profile_hosts="$HOME/.config/lcu-chrome-direct-fixture/NativeMessagingHosts"
mkdir -p "$profile_hosts"
cp "$manifest" "$profile_hosts/"
export LCU_BROWSER_OUTPUT_DIR=/tmp/lcu-browser-output
python3 "$test_dir/harness_browser_fixture.py" >/tmp/lcu-browser-fixture.log 2>&1 &
fixture_pid=$!
Xvfb :99 -screen 0 1280x800x24 >/tmp/lcu-browser-xvfb.log 2>&1 &
xvfb_pid=$!
export DISPLAY=:99
rm -f /tmp/lcu-browser-ready
"$release/app/resources/cua_node/bin/node" "$test_dir/browser_launch.mjs" >/tmp/lcu-browser.log 2>&1 &
browser_pid=$!
cleanup() {
  kill "$browser_pid" "$fixture_pid" "$xvfb_pid" 2>/dev/null || true
  wait "$browser_pid" "$fixture_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
for attempt in $(seq 1 300); do
  kill -0 "$fixture_pid" 2>/dev/null || { cat /tmp/lcu-browser-fixture.log >&2; exit 1; }
  page_ready=0
  chrome_ready=0
  curl --silent --fail http://127.0.0.1:8080/ >/dev/null && page_ready=1
  [[ -f /tmp/lcu-browser-ready ]] && chrome_ready=1
  if (( page_ready && chrome_ready )); then break; fi
  sleep 0.2
done
[[ -f /tmp/lcu-browser-ready ]] || { cat /tmp/lcu-browser.log >&2; exit 1; }
python3 - <<'PY'
import json
from pathlib import Path
state = json.loads(Path('/tmp/lcu-browser-ready').read_text())
assert state['browserKind'] == 'chrome', state
assert state['extensionServiceWorker'].startswith('chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/'), state
assert state['extensionVersion'] == '1.26.901.11451', state
assert state['browserVersion'] != 'unavailable', state
print('Official Chrome fixture ready:', json.dumps(state, sort_keys=True))
PY
echo 'Generated fixture server listening on http://127.0.0.1:8080; keeping isolated Chrome alive.'
wait "$browser_pid"
