#!/usr/bin/env bash
# Internal helper: one completely fresh desktop for one side of the comparison.
set -euo pipefail
tests=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export DISPLAY=:99 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
export HOME="$DIFFERENTIAL_OUTPUT/home" XDG_RUNTIME_DIR="$DIFFERENTIAL_OUTPUT/xdg"
mkdir -p "$HOME/.local/share/applications" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
cat >"$HOME/.local/share/applications/lcu-differential.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=LCU Differential Launcher
Exec=python3 $tests/differential_fixture.py --launched
Terminal=false
EOF
processes=()
cleanup() {
  for pid in "${processes[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${processes[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >"$DIFFERENTIAL_OUTPUT/xvfb.log" 2>&1 & processes+=("$!")
for attempt in {1..50}; do if xdpyinfo >/dev/null 2>&1; then break; fi; sleep .1; done
if [[ ${DIFFERENTIAL_DESKTOP:-openbox} == xfce ]]; then
  export XDG_SESSION_TYPE=x11
  xfce4-session >"$DIFFERENTIAL_OUTPUT/xfce.log" 2>&1 & processes+=("$!")
else
  openbox >"$DIFFERENTIAL_OUTPUT/openbox.log" 2>&1 & processes+=("$!")
fi
python3 "$tests/differential_fixture.py" >"$DIFFERENTIAL_OUTPUT/fixture.log" 2>&1 & processes+=("$!")
export LCU_TEST_OUTPUT="$DIFFERENTIAL_OUTPUT"
python3 "$tests/x11_fixture.py" >"$DIFFERENTIAL_OUTPUT/x11-fixture.log" 2>&1 & processes+=("$!")
if [[ ${DIFFERENTIAL_AUDIO:-0} == 1 ]]; then
  pulseaudio --daemonize --exit-idle-time=-1 --log-target="file:$DIFFERENTIAL_OUTPUT/pulse.log"
  if [[ -f "$XDG_RUNTIME_DIR/pulse/pid" ]]; then
    pulse_pid=$(cat "$XDG_RUNTIME_DIR/pulse/pid")
    [[ $pulse_pid =~ ^[0-9]+$ ]] && processes+=("$pulse_pid")
  fi
  pactl load-module module-null-sink sink_name=lcu_differential >/dev/null
  pactl set-default-sink lcu_differential
  ffmpeg -hide_banner -loglevel error -re -f lavfi -i sine=frequency=440 -f pulse default >"$DIFFERENTIAL_OUTPUT/sine.log" 2>&1 & processes+=("$!")
fi
python3 "$tests/differential.py" exercise "$@"
