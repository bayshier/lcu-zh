#!/usr/bin/env bash
# Prepare a generated desktop from local, verified test inputs. No acquisition.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
archive=${1:?Provide an absolute thin LCU archive path}
package=${2:?Provide an absolute verified official test DEB path}
name=${3:?Provide a new disposable container name}
output=${4:?Provide an absolute evidence directory outside the repository}
platform=${5:-linux/arm64}
case "$platform" in linux/arm64|linux/amd64) ;; *) exit 2 ;; esac
for input in "$archive" "$archive.sha256" "$package"; do
  [[ "$input" = /* && -f "$input" ]] || { echo 'Inputs must be absolute existing files' >&2; exit 2; }
done
[[ "$output" = /* ]] || { echo 'Output must be absolute' >&2; exit 2; }
python3 - "$repo" "$output" <<'PY'
from pathlib import Path
import sys
repo, output = map(lambda p: Path(p).resolve(), sys.argv[1:])
if output.is_relative_to(repo):
    raise SystemExit('Generated original instructions must stay outside the repository')
output.mkdir(parents=True, exist_ok=True)
if (output / 'doctor.log').exists():
    raise SystemExit('Use a fresh output directory')
PY
docker run -d --name "$name" --label lcu.harness-fixture=1 --network none \
  --platform "$platform" -v "$archive:/bundle.tar.gz:ro" \
  -v "$archive.sha256:/bundle.sha256:ro" -v "$package:/package.deb:ro" \
  -v "$repo:/src:ro" -v "$repo/tests:/test-input:ro" \
  "lcu-verification:${platform#linux/}" sleep infinity
# Only clean up a container that this invocation successfully created.
trap 'docker rm -f "$name" >/dev/null' ERR
docker exec -i "$name" bash -se <<'SH'
python3 - <<'PY'
import hashlib, json, platform
from pathlib import Path
assert {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}
arch = {'aarch64': 'arm64', 'x86_64': 'x64'}[platform.machine()]
lock = json.loads(Path('/src/runtime.lock.json').read_text())
for path, expected in [('/package.deb', lock['architectures'][arch]['sha256']),
                       ('/bundle.tar.gz', Path('/bundle.sha256').read_text().split()[0])]:
    with open(path, 'rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected, path
PY
mkdir /tmp/bundle
tar -xzf /bundle.tar.gz -C /tmp/bundle --strip-components=1
dpkg-deb --extract /package.deb /tmp/upstream
useradd --create-home lcutester
/tmp/bundle/scripts/install.sh --runtime-only --skip-system --offline --yes \
  --user lcutester --prefix /opt/lcu --existing-app /tmp/upstream/usr/lib/chatgpt
runuser -u lcutester -- /opt/lcu/current/bin/lcu setup \
  --export /home/lcutester/export --session direct --yes
cat >/tmp/lcu-runtime <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
source /tmp/lcu-desktop.env
exec /opt/lcu/current/bin/lcu "$@"
WRAPPER
chmod 755 /tmp/lcu-runtime
SH
docker exec -d -u lcutester "$name" dbus-run-session -- bash /test-input/harness_desktop.sh
docker exec "$name" bash -c 'for attempt in {1..100}; do
  if test -s /tmp/lcu-desktop.env && DISPLAY=:99 xwininfo -root -tree | grep -q "LCU Target"; then exit 0; fi
  sleep .1
done; exit 1'
docker exec -u lcutester "$name" /tmp/lcu-runtime doctor >"$output/doctor.log"
printf 'Fixture ready: %s\nOutput: %s\nCleanup: docker rm -f %s\n' "$name" "$output" "$name"
