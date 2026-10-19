# Current Linux archive gates, 2026-09-24

The tested source was `b11ae52cbadadbec8158e1ca1a8db460a6fdf8b4`. Both Linux archives were built from that checkout and passed the existing offline release gate. This is a disposable Docker check: ARM64 ran natively on Apple Silicon; x86-64 ran under emulation. It does not replace the earlier physical-host AppArmor and Chrome-extension tests or prove a personal desktop.

| Archive | SHA-256 |
| --- | --- |
| `.verification/arm64.W3EtTY/lcu-0.3.0-linux-arm64.tar.gz` | `6d6b6f2871f97f41f6ea77490adfd30e1f59a11fe86d2fdf0baa9c1983382e51` |
| `.verification/amd64.n4NxxV/lcu-0.3.0-linux-x64.tar.gz` | `7ad09f745c329b55298edfd15ad89ca7a726b5826e67bb6a8b59701168897578` |

Commands, using the pinned official packages already present on the test host:

```sh
bash tests/run.sh linux/arm64 /private/tmp/silo-cua-engine.yy0cvD/chatgpt_arm64.deb
bash tests/run.sh linux/amd64 /private/tmp/lcu-x64-input/packages/chatgpt_amd64.deb
```

Both exited zero. Each verified the package checksum, built and checksummed its thin archive, installed without acquisition network, rejected a corrupt package without changing the selected release, survived a forced system-library acquisition failure, raced two installer processes, and checked the selected release manifest and staging cleanup. Each ran **120 Python tests**, registered Codex CLI, Claude Code and Pi in user and project scopes, compared generated original Linux and optional Chrome instruction references, checked ownership and repeat setup, executed a portable MCP export as the target account, and passed the original MCP native X11/GTK fixture. That fixture checked AT-SPI, Unicode and keyboard input, clipboard, window isolation, an independent saved-file oracle, screenshots, persistent JavaScript, reset, timeout recovery and coordinate fallback. The deliberate timeout diagnostic was expected.

Separately, each archive was installed in a disposable `--network none` container and its exact selected app executable `/opt/lcu/current/app/resources/codex` ran the no-auth `require_cli_hook_support` probe. Both reported `codex-cli 0.155.0-alpha.9.2` and accepted a temporary `mcp_tool` Stop hook configuration. The probe used an empty temporary Codex home and made no model call. It verifies parser compatibility on these Linux binaries, not a minimum public Codex CLI version or model behavior. Real interactive Codex model behavior is recorded [separately](codex-interactive-2026-09-24.md).

The same `b11ae52` source produced `/private/tmp/lcu-final-windows/lcu-0.3.0-windows-x64.zip`, SHA-256 `a0ebdd058b2cafe0f9037b5cc4df3b6faad230be2f6eb60bbaeb2595ddc95b0a`. Its sidecar matched and `unzip -tq` found no compressed-data error. This is a build check only; Windows installation and behavior require the separate VM gate.

Local Linux gate logs are `/private/tmp/lcu-gate-b11ae52-{arm64,amd64}.log`. The prior two attempts at `67a8b61` stopped at test import because the new Windows pipe regression lacked the source path when discovered from the archive directory. Test-only commit `5cbe94f` fixed that path; both full gates above passed afterward. No production file changed between these candidate sources. The earlier Codex model-test containers are gone, and no temporary LCU auth symlink remains under `/private/tmp`.
