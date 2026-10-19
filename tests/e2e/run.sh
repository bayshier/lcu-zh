#!/bin/sh
# End-to-end comparison of two LCU trees: tests/e2e/run.sh [--old TREE|REF] [--new TREE|REF] [CHECK...]
# Checks: setup exit launch upgrade nopython startup (default: all). --self-test validates the harness.
# Needs python3 (harness only), node >= 22.15 and network for the first build of each tree (cached).
# Root (or passwordless sudo) gives each sandbox a disposable account; without it, setup-related checks skip.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "$(id -u)" != 0 ] && [ -z "${E2E_NO_SUDO:-}" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  exec sudo -E env "PATH=$PATH" python3 "$here/e2e.py" "$@"
fi
exec python3 "$here/e2e.py" "$@"
