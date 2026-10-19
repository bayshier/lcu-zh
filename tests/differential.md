# Upstream differential verification

Run the pinned package and the built release against independent fresh desktops in the disposable test image. No personal desktop or credentials are mounted. The test requires networking disabled and verifies both package and archive checksums before execution.

```sh
docker run --rm --network none --platform linux/arm64 \
  -v "$PWD:/src:ro" \
  -v /absolute/chatgpt_arm64.deb:/package.deb:ro \
  -v /absolute/bundles:/bundles:ro \
  -v /absolute/empty-evidence:/evidence \
  -e DIFFERENTIAL_AUDIO=1 -e DIFFERENTIAL_XFCE=1 \
  lcu-full-test:arm64 bash /src/tests/differential.sh \
  /package.deb /bundles/lcu-0.3.0-linux-arm64.tar.gz /evidence
```

Repeat with platform/image `linux/amd64`/`lcu-full-test:amd64`, the pinned AMD64 package, and the `linux-x64` archive. Build the images from `tests/Dockerfile`. The output directory must start empty. Preserve the output even when a test fails.

The gate checks every original runtime file, symlink target, and file mode against the freshly extracted official package. Its baseline launcher imports no LCU implementation. Each side starts its own Xvfb, desktop session bus, window manager, and independent GTK/Xlib fixtures. GUI results come from saved files, received events, window lifecycle, clipboard/focus/pointer observations, and audio WAV contents. The comparator checks complete tool schemas, original documentation, and semantic results; it does not compare nondeterministic screenshot bytes or pointer-motion event counts.

The 12-mode matrix covers computer-only, browser-only, and combined surfaces with `codex-app`, `training`, `cloud`, and `orbit` browser modes. It checks first-use delivery and methods. **It does not claim successful browser operations without a real backend.** Browser provider and actual Codex host tests are separate.

Native, XFCE, mode-matrix, and model-delivery fixtures explicitly select `BROWSER_USE_AVAILABLE_BACKENDS=chrome,cdp` for both original and LCU. These tests do not start the Electron IAB host inside root-owned test containers. The separate IAB suite covers that provider and states its fixture-only Electron settings.

Failure gates close a real window before attempting input and check continuously recorded live widget contents, then inject a single native-helper process exit or malformed transport response and verify that the next request starts the original helper successfully. The actual Codex host test also sends an identical GUI action through approved and denied fixture policies: the approved action must produce the independent Xlib event file, while denial must leave it unchanged.

`DIFFERENTIAL_AUDIO=1` enables local PulseAudio recording of a generated sine signal, with no microphone or external audio. `DIFFERENTIAL_XFCE=1` additionally starts a real XFCE session and removes every GUI variable from the caller before using `lcu-session`; this tests LCU-specific discovery separately from upstream parity.

Passing establishes equivalence for the exercised runtime paths and byte preservation for all copied runtime files. It does not establish model task-success rates, arbitrary application compatibility, Wayland support, cloud-provider availability, or universal reliability.
