# Platform regression after macOS adapter work

Date: 2026-09-24. The checkout was based on `8916228e2de5f3480c3c613af745d9bc8a828df7` with uncommitted platform work. These tests ran in disposable Linux Docker images, not on a personal desktop. The ARM64 image ran natively on Apple Silicon; the x86-64 image ran under emulation. Neither Docker run proves Ubuntu host AppArmor behavior or live Chrome operation.

## Offline release gates

The local official packages matched the SHA-256 pins in `runtime.lock.json` before testing. The exact commands were:

```sh
bash tests/run.sh linux/arm64 /private/tmp/silo-cua-engine.yy0cvD/chatgpt_arm64.deb
bash tests/run.sh linux/amd64 /private/tmp/lcu-x64-input/packages/chatgpt_amd64.deb
```

Both exited 0. Each built a thin archive, installed the pinned package with acquisition network disabled, passed 79 Python tests, registered seven agents in user and project scopes, exercised portable MCP export, and passed the X11/GTK desktop fixture. The deliberate JavaScript timeout emitted its expected diagnostic and recovery passed.

| Architecture | Gate archive | SHA-256 |
| --- | --- | --- |
| ARM64 native Docker | `.verification/arm64.AYYZRd/lcu-0.3.0-linux-arm64.tar.gz` | `674b19c9dcee412fbbe775a975379c7a39328d02b0e10eef87e8e1ccf7594519` |
| x86-64 emulated Docker | `.verification/amd64.OfNpYp/lcu-0.3.0-linux-x64.tar.gz` | `1354445e67bc60254ab5834a3fb670cf081473898945c3b2f5210288454fa926` |

## Original-versus-LCU differential

Both gate archives were then installed and compared with their pinned original runtimes inside matching containers with `--network none` and `DIFFERENTIAL_XFCE=1`. Both `tests/differential.sh` processes exited 0. Evidence directories are `/private/tmp/lcu-platform-diff-arm64/` and `/private/tmp/lcu-platform-diff-x64/`. Each matched 25 native cases plus complete MCP schemas and documentation, 12 configuration modes, real XFCE discovery, scripted Codex model delivery and approvals, and Stop/Interrupt/SubagentStop lifecycle. The native-pipe probe verified backlog failure, recovery, bytes and a delayed response; real Linux backlog returned `EAGAIN` immediately, so connect-timeout expiration was not covered. A scripted model and local GUI fixtures do not prove autonomous model behavior or Chrome/site approval.

The commands mounted the source read-only as `/src`, the matching pinned package as `/package.deb`, the matching gate archive directory as `/bundles`, and a separate empty evidence directory as `/out`; the ARM64 command was:

```sh
docker run --rm --network none --platform linux/arm64 -v /private/tmp/lcu-platform-adapters:/src:ro -v /private/tmp/silo-cua-engine.yy0cvD/chatgpt_arm64.deb:/package.deb:ro -v /private/tmp/lcu-platform-adapters/.verification/arm64.AYYZRd:/bundles:ro -v /private/tmp/lcu-platform-diff-arm64:/out -e DIFFERENTIAL_XFCE=1 lcu-verification:arm64 bash /src/tests/differential.sh /package.deb /bundles/lcu-0.3.0-linux-arm64.tar.gz /out
```

The x86-64 command used `--platform linux/amd64`, `lcu-verification:amd64`, `/private/tmp/lcu-x64-input/packages/chatgpt_amd64.deb`, `.verification/amd64.OfNpYp`, and `/private/tmp/lcu-platform-diff-x64` with the corresponding x64 archive name. Its final subagent lifecycle case took longer under emulation; `docker top` showed its Codex and original Node/REPL children active, and the run exited 0 without intervention.

After `lcu/codex_hooks.py` changed, a focused native ARM64 Docker check mounted the current source and checksum-matched original runtime with `--network none`. `tests/codex_lifecycle.py` exited 0 and verified exact live Stop, Interrupt, and SubagentStop IDs, overlapping hook cleanup once, no cleanup without hooks, and preserved unrelated policy. Its evidence is `/private/tmp/lcu-platform-current-hooks/run/summary.json`. This checks the current hook code without repeating the full archive gates.

## Source-to-archive boundary

The gate archives were created while other platform work was still being finished. Comparing every archive member sourced directly from the checkout to current files found these later changes in both archives: `README.md`, `adapters/pi/index.ts`, `docs/ADAPTERS.md`, `docs/INSTALLATION.md`, `docs/INSTRUCTIONS.md`, `docs/PARITY-STATUS.md`, `docs/PROVENANCE.md`, `docs/STANDALONE-ADAPTATIONS.md`, `lcu/codex_hooks.py`, and `lcu/setup_clients.py`. No other repository-controlled archive member differed in that comparison. `lcu/codex_hooks.py` canonicalizes a temporary path for macOS `/var` versus `/private/var`; Linux `/tmp` path behavior is unchanged, and the focused current-source check above passed. `lcu/setup_clients.py` changed the VS Code display label and selects `Library/Application Support/Code` on macOS while retaining the existing Linux `.config/Code` path. The latest Pi adapter and documentation were tested separately on macOS by the parent task; these Linux archives should not be presented as exact final-source artifacts.
