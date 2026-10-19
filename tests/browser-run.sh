#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
platform=${1:?Expected linux/arm64 or linux/amd64}
bundle=${2:?Expected an absolute thin LCU release archive}
package=${3:?Expected an absolute official pinned ChatGPT .deb}
browser=${4:-${LCU_BROWSER_KIND:-chromium}}
case "$platform" in linux/arm64|linux/amd64) ;; *) exit 2 ;; esac
case "$browser" in chromium|chrome) ;; *) echo 'Expected browser kind chromium or chrome' >&2; exit 2 ;; esac
[[ "$bundle" = /* && -f "$bundle" && "$package" = /* && -f "$package" ]] || exit 2
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
cp "$bundle" "$context/release.tar.gz"
cp "$package" "$context/chatgpt.deb"
cp "$repo/tests/browser_extension.py" "$context/browser_extension.py"
cp "$repo/tests/browser.Dockerfile" "$context/Dockerfile"
tag="lcu-browser-verification:${platform#linux/}"
docker build --platform "$platform" \
  --build-arg "BASE_IMAGE=${LCU_BROWSER_TEST_BASE:-lcu-verification:${platform#linux/}}" \
  --build-arg "BROWSER_KIND=$browser" -t "$tag" "$context"
# Docker's default seccomp denies the namespaces used by Chrome's own sandbox.
# Relax that test-container filter; never launch Chrome with --no-sandbox.
docker run --rm --network none --security-opt seccomp=unconfined --platform "$platform" -e "LCU_BROWSER_KIND=$browser" -v "$repo:/src:ro" \
  "$tag" dbus-run-session -- bash /src/tests/browser_session.sh
