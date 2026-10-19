#!/usr/bin/env bash
set -euo pipefail
test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
release=${LCU_BROWSER_RELEASE:?Browser test image must install the pinned app into a disposable prefix}
browser_kind=${LCU_BROWSER_KIND:-chromium}
[[ "$(id -u)" != 0 ]] || { echo 'Browser integration must run as the disposable unprivileged browser-test account.' >&2; exit 2; }
[[ -x "$release/bin/lcu" && -x "$release/app/resources/cua_node/bin/node" ]] || {
  echo 'Installed LCU release is incomplete.' >&2
  exit 2
}
if [[ "$browser_kind" == chrome ]]; then
  echo 'NOTICE: unprivileged disposable Google Chrome profile; this test exercises real browser actions without Codex sign-in.'
else
  echo 'NOTICE: unprivileged disposable Playwright Chromium profile; this test exercises real browser actions without Codex sign-in.'
fi
manifest="$HOME/.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json"
[[ ! -e "$manifest" && ! -e "$HOME/.local/share/lcu/browser" ]] || {
  echo 'Runtime-only installation unexpectedly configured a Chrome native host.' >&2
  exit 1
}
"$release/bin/lcu" setup --prefix "$LCU_BROWSER_PREFIX" --export "$HOME/lcu-browser-export" --session direct --chrome --yes
[[ -f "$manifest" ]] || { echo "LCU native-host manifest missing after setup --chrome: $manifest" >&2; exit 1; }
if [[ "$browser_kind" == chrome ]]; then
  # The fixture uses a non-default Chrome data directory for loopback DevTools.
  # Chrome resolves user-level native hosts from that directory.
  profile_hosts="$HOME/.config/lcu-chrome-direct-fixture/NativeMessagingHosts"
  mkdir -p "$profile_hosts"
  cp "$manifest" "$profile_hosts/"
fi
rm -f /tmp/lcu-browser-ready
Xvfb :99 -screen 0 1280x800x24 >/tmp/lcu-browser-xvfb.log 2>&1 &
xvfb_pid=$!
export DISPLAY=:99
"$release/app/resources/cua_node/bin/node" "$test_dir/browser_launch.mjs" >/tmp/lcu-browser.log 2>&1 &
browser_pid=$!
cleanup() {
  kill "$browser_pid" "$xvfb_pid" 2>/dev/null || true
  wait "$browser_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
for attempt in $(seq 1 300); do
  [[ -f /tmp/lcu-browser-ready ]] && break
  sleep 0.2
done
[[ -f /tmp/lcu-browser-ready ]] || { cat /tmp/lcu-browser.log; exit 1; }
python3 - <<'PY'
import json
import os
from pathlib import Path
details = json.loads(Path('/tmp/lcu-browser-ready').read_text())
print(f"{details['browserKind']} fixture:", json.dumps(details, sort_keys=True))
assert details['browserKind'] == os.environ.get('LCU_BROWSER_KIND', 'chromium')
assert details['extensionServiceWorker'].startswith('chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/')
assert details['browserVersion'] != 'unavailable'
assert details['extensionVersion'] == '1.26.901.11451'
assert 'Chrome/' in details['userAgent']
PY
if [[ "$browser_kind" == chrome ]]; then
  echo 'Google Chrome fixture discovery result (installed inside disposable image):'
else
  echo 'Chromium fixture discovery result (not installed Google Chrome validation):'
fi
python3 -B "$test_dir/browser_runtime.py" "$release" "$release/app/resources/cua_node"
