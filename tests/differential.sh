#!/usr/bin/env bash
# Run inside the disposable test image. No personal sessions or credentials.
# Usage: differential.sh PINNED_PACKAGE.deb RELEASE.tar.gz OUTPUT_DIRECTORY
set -euo pipefail
tests=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package=${1:?Provide pinned official package}
archive=${2:?Provide LCU release archive}
output=${3:?Provide an empty evidence directory}
mkdir -p "$output"
[[ -z $(ls -A "$output") ]] || { echo 'Evidence directory must be empty' >&2; exit 2; }
export PYTHONDONTWRITEBYTECODE=1
python3 - "$package" "$tests/../runtime.lock.json" <<'PY'
import hashlib,json,platform,sys
from pathlib import Path
assert {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}, 'Requires --network none'
arch={'aarch64':'arm64','x86_64':'x64'}[platform.machine()]
lock=json.loads(Path(sys.argv[2]).read_text())
with open(sys.argv[1],'rb') as source:
    assert hashlib.file_digest(source,'sha256').hexdigest() == lock['architectures'][arch]['sha256']
PY
(cd "$(dirname -- "$archive")"; sha256sum -c "$(basename -- "$archive").sha256")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# Both sides must execute one immutable test revision even in an actively edited
# checkout. The release and source package were already checksum-verified above.
mkdir "$scratch/tests"
cp "$tests"/differential* "$tests"/host_delivery.* "$tests/codex_lifecycle.py" "$tests/lcu_node.py" "$tests/browser_runtime.py" "$tests/native_pipe.py" "$tests/codex_home.py" "$tests/mcp_client.py" "$tests/x11_fixture.py" "$scratch/tests/"
tests="$scratch/tests"
dpkg-deb --extract "$package" "$scratch/upstream"
tar -xzf "$archive" -C "$scratch"
bundle="$scratch/$(basename -- "$archive" .tar.gz)"
"$bundle/scripts/install.sh" --user "$(id -un)" --prefix "$scratch/installed" --runtime-only --skip-system --existing-app "$scratch/upstream/usr/lib/chatgpt" --offline --yes
export DIFFERENTIAL_UPSTREAM_RUNTIME="$scratch/upstream/usr/lib/chatgpt/resources/cua_node"
python3 "$tests/native_pipe.py" "$scratch/installed/current" "$DIFFERENTIAL_UPSTREAM_RUNTIME" "$output/native-pipe.json"
python3 "$tests/codex_home.py" "$scratch/installed/current" "$DIFFERENTIAL_UPSTREAM_RUNTIME" "$output/codex-home.json"
python3 - "$DIFFERENTIAL_UPSTREAM_RUNTIME" "$scratch/installed/current/app/resources/cua_node" "$output/runtime-inventory.json" <<'PY'
import hashlib,json,os,stat,sys
from pathlib import Path
def inventory(root):
    result={}
    for path in root.rglob('*'):
        name=str(path.relative_to(root))
        if path.is_symlink():result[name]={'symlink':os.readlink(path)}
        elif path.is_file():
            with path.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
            result[name]={'sha256':digest,'mode':stat.S_IMODE(path.stat().st_mode)}
    return result
a,b=map(lambda value:inventory(Path(value)),sys.argv[1:3])
assert a == b, {'missing':sorted(set(a)-set(b)), 'additional':sorted(set(b)-set(a)),
                'changed':sorted(key for key in a.keys() & b.keys() if a[key] != b[key])}
Path(sys.argv[3]).write_text(json.dumps({'verified_original_files':len(a),'additional_files':sorted(set(b)-set(a))},indent=2))
PY
for side in upstream lcu; do
  export DIFFERENTIAL_OUTPUT="$output/$side"
  mkdir -p "$DIFFERENTIAL_OUTPUT"
  if [[ $side == upstream ]]; then
    command=(python3 "$tests/differential_baseline.py")
    export DIFFERENTIAL_RUNTIME="$scratch/upstream/usr/lib/chatgpt/resources/cua_node"
  else
    command=("$scratch/installed/current/bin/lcu")
    export DIFFERENTIAL_RUNTIME="$scratch/installed/current/app/resources/cua_node"
  fi
  dbus-run-session -- bash "$tests/differential_session.sh" "${command[@]}" >"$DIFFERENTIAL_OUTPUT/session.log" 2>&1
  python3 "$tests/differential_matrix.py" exercise "$DIFFERENTIAL_OUTPUT/matrix.json" "${command[@]}" >"$DIFFERENTIAL_OUTPUT/matrix.log" 2>&1
done
python3 "$tests/differential.py" compare "$output"
python3 "$tests/differential_matrix.py" compare "$output/upstream/matrix.json" "$output/lcu/matrix.json"
if [[ ${DIFFERENTIAL_XFCE:-0} == 1 ]]; then
  bash "$tests/differential_xfce.sh" "$scratch/installed" "$output/xfce"
fi
dbus-run-session -- bash "$tests/host_delivery.sh" \
  "$scratch/upstream/usr/lib/chatgpt/resources" "$scratch/installed/current" "$output/host"
for side in upstream lcu; do
  lifecycle_args=()
  if [[ $side == lcu ]]; then lifecycle_args=(--release "$scratch/installed/current"); fi
  LCU_MODULE_ROOT="$scratch/installed/current" python3 "$tests/codex_lifecycle.py" \
    "$scratch/upstream/usr/lib/chatgpt/resources" "$output/lifecycle-$side" "${lifecycle_args[@]}"
done
