#!/usr/bin/env bash
# Internal offline helper, invoked inside its own D-Bus session.
set -euo pipefail
output=${3:?Evidence output directory}
mkdir -p "$output"
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >"$output/xvfb.log" 2>&1 &
xvfb_pid=$!
wm_pid=
trap 'if [[ -n $wm_pid ]]; then kill "$wm_pid" 2>/dev/null || true; wait "$wm_pid" 2>/dev/null || true; fi; kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true' EXIT
export DISPLAY=:99
for attempt in {1..50}; do if xdpyinfo >/dev/null 2>&1; then break; fi; sleep .1; done
openbox >"$output/openbox.log" 2>&1 & wm_pid=$!
# Do not race the first fixture's MapWindow request against WM initialization.
for attempt in {1..100}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x'; then break; fi
  sleep .05
done
python3 "$(dirname -- "$0")/host_delivery.py" "$@"
