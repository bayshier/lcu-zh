#!/bin/sh
# Copies the showreel and its poster from docs/assets into site/media.
# Vercel runs this with Root Directory set to site and outside-root files enabled.
# Run locally before previewing; CLI deployments must upload the repository root.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$root/site/media"
cp "$root/docs/assets/lcu-showreel.mp4" "$root/docs/assets/lcu-showreel-poster.jpg" "$root/site/media/"
