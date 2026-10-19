#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
platform=${1:-linux/arm64}
case "$platform" in linux/arm64|linux/amd64) ;; *) echo 'Expected linux/arm64 or linux/amd64' >&2; exit 2 ;; esac
tag="lcu-verification:${platform#linux/}"
docker build --platform "$platform" -t "$tag" -f "$repo/tests/Dockerfile" "$repo"
mkdir -p "$repo/.verification"
output=$(mktemp -d "$repo/.verification/${platform#linux/}.XXXXXX")
package=${2:-$output/upstream.deb}
if [[ $# -ge 2 ]]; then
  [[ "$package" = /* && -f "$package" ]] || { echo 'Package must be an existing absolute file path' >&2; exit 2; }
else
# Keep the pinned source package for offline install validation.
  docker run --rm --platform "$platform" -v "$repo:/src:ro" -v "$output:/out" "$tag" python3 -c '
import json,sys
from pathlib import Path
sys.path[:0]=["/src/scripts","/src"]
from bundle import architecture, download_fixture
lock=json.loads(Path("/src/runtime.lock.json").read_text()); entry=lock["architectures"][architecture()]
download_fixture(lock,entry,Path("/out/upstream.deb"))
'
fi
mounts=(-v "$repo:/src:ro" -v "$package:/package.deb:ro")
docker run --rm --platform "$platform" -v "$repo:/src:ro" -v "$output:/out" \
  -e PYTHONDONTWRITEBYTECODE=1 "$tag" \
  python3 /src/scripts/build_bundle.py --output /out
archive=$(find "$output" -maxdepth 1 -name '*.tar.gz' -print)
[[ -n "$archive" ]] || exit 1
docker run --rm --network none --platform "$platform" "${mounts[@]}" -v "$output:/bundles:ro" \
  -e PYTHONDONTWRITEBYTECODE=1 "$tag" \
  bash /src/tests/offline.sh "/bundles/$(basename -- "$archive")" /package.deb
# The same app mounted read-only, in two version folders, as a system install would be.
version=$(docker run --rm --platform "$platform" "${mounts[@]}" "$tag" dpkg-deb -f /package.deb Version)
volume="lcu-readonly-app-$$"
cleanup_volume() { docker volume rm -f "$volume" >/dev/null 2>&1 || true; }
trap cleanup_volume EXIT
docker volume create "$volume" >/dev/null
docker run --rm --network none --platform "$platform" "${mounts[@]}" -v "$volume:/app" "$tag" \
  bash -c 'dpkg-deb --extract /package.deb /tmp/extracted && cp -a /tmp/extracted/usr/lib/chatgpt/. /app/'
first="/opt/silo/chatgpt/$version"
second="/opt/silo/chatgpt/$version-moved"
# Docker's default profile also stops the original node_repl from sandboxing child processes, which hides a
# whole class of failures. This gate lets bubblewrap work (as on a normal VM) and requires that it does.
sandbox_flags=(--security-opt seccomp=unconfined --security-opt apparmor=unconfined --cap-add SYS_ADMIN)
# Under emulation (the other architecture) bubblewrap cannot start, so the sandbox cannot be required there.
case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) native=linux/arm64 ;;
  x86_64|amd64) native=linux/amd64 ;;
  *) native= ;;
esac
require_sandbox=0
if [[ "$platform" = "$native" ]]; then require_sandbox=1; else echo "Emulated $platform: the original sandbox cannot be required in this gate." >&2; fi
docker run --rm --network none --platform "$platform" "${mounts[@]}" -v "$output:/bundles:ro" \
  -v "$volume:$first:ro" -v "$volume:$second:ro" "${sandbox_flags[@]}" \
  -e PYTHONDONTWRITEBYTECODE=1 -e LCU_REQUIRE_SANDBOX="$require_sandbox" "$tag" \
  bash /src/tests/offline-readonly.sh "/bundles/$(basename -- "$archive")" "$first" "$second"
printf 'Archive and evidence: %s\n' "$output"
