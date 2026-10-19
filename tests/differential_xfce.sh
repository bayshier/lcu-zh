#!/usr/bin/env bash
# Verify LCU's default real-session discovery separately from upstream parity.
# Run only in the isolated test image: installed prefix, empty evidence directory.
set -euo pipefail
tests=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prefix=${1:?Installed LCU prefix}
output=${2:?Empty evidence directory}
mkdir -p "$output"
[[ -z $(ls -A "$output") ]] || { echo 'Evidence directory must be empty' >&2; exit 2; }
export DIFFERENTIAL_OUTPUT="$output" DIFFERENTIAL_DESKTOP=xfce DIFFERENTIAL_SURFACES=browser,computer PYTHONDONTWRITEBYTECODE=1
export DIFFERENTIAL_RUNTIME="$prefix/current/app/resources/cua_node"
dbus-run-session -- bash "$tests/differential_session.sh" \
  env -u DISPLAY -u XAUTHORITY -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR -u XDG_SESSION_TYPE \
  "$prefix/current/bin/lcu-session" --user "$(id -un)" -- "$prefix/current/bin/lcu" \
  >"$output/session.log" 2>&1
echo 'PASS: real XFCE discovery after removing all caller GUI session variables; complete desktop exercise passed under default combined surfaces'
