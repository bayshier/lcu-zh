#!/usr/bin/env bash
# Start only generated GTK windows inside a disposable container's D-Bus session.
set -euo pipefail
export DISPLAY=:99 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
export XDG_RUNTIME_DIR=/tmp/lcu-desktop-runtime LCU_TEST_OUTPUT=/tmp/lcu-desktop-output
mkdir -p "$XDG_RUNTIME_DIR" "$LCU_TEST_OUTPUT"
chmod 700 "$XDG_RUNTIME_DIR"
python3 - <<'PY'
import os,shlex
from pathlib import Path
names=('DISPLAY','DBUS_SESSION_BUS_ADDRESS','GTK_MODULES','NO_AT_BRIDGE','XDG_RUNTIME_DIR','LCU_TEST_OUTPUT')
Path('/tmp/lcu-desktop.env').write_text('\n'.join('export '+name+'='+shlex.quote(os.environ[name]) for name in names)+'\n')
PY
processes=()
cleanup() { for pid in "${processes[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >"$LCU_TEST_OUTPUT/xvfb.log" 2>&1 & processes+=("$!")
for attempt in {1..50}; do if xdpyinfo >/dev/null 2>&1; then break; fi; sleep .1; done
openbox >"$LCU_TEST_OUTPUT/openbox.log" 2>&1 & processes+=("$!")
for attempt in {1..50}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x'; then break; fi
  sleep .1
done
python3 /test-input/fixture.py >"$LCU_TEST_OUTPUT/fixture.log" 2>&1 & processes+=("$!")
wait "${processes[-1]}"
