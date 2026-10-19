# Focused delivery verification, 2026-09-24

The tested implementation is commit `d862ea71123b90010381d1434a545f2c0cbd26fc`. Later commits add verification records only. These are local development artifacts, not published releases or a claim of complete cross-platform support.

| Thin archive | SHA-256 |
| --- | --- |
| `lcu-0.3.0-linux-arm64.tar.gz` | `84bee1e99cc5216071093f53366a35dc7c9ea9a16714e46db68be666bdb4a655` |
| `lcu-0.3.0-linux-x64.tar.gz` | `4c88eda66f5b15e3cb7a089c996f4d2053828101abd7bcb8814a760149b42298` |
| `lcu-0.3.0-darwin-arm64.tar.gz` | `93a3adaa27b082ca2e1bc38441d53c00626e0540a56e9f6fbf79ccb698f59dc3` |

The Linux archives were produced by `tests/run.sh linux/arm64 PACKAGE` and `tests/run.sh linux/amd64 PACKAGE`, using the pinned official packages. Both commands exited zero. Each ran 97 Python checks, offline install and failure recovery, concurrent installer checks, actual Codex CLI/Claude Code/Pi registration in user and project scopes, preservation of unrelated configuration, idempotency, portable export, and the native X11/GTK fixture. The native fixture verified original tool discovery and Linux instructions, accessibility, Unicode input, keyboard and clipboard actions, window isolation, independent saved-file output, screenshot content, persistent state, reset, and timeout recovery.

The final setup automatically reported the missing Chrome profile/extension and the correctly installed connector in the fresh accounts. Missing Chrome did not fail native setup. Pi commands are kept in account-owned configuration; an unregistered repository file cannot replace the configured executable. User and project scopes register the same local Pi package, avoiding duplicate tools.

Both exact Linux archives were then installed afresh in existing disposable Google Chrome test images. The containers had `--network none`; the only websites were loopback fixtures. No `BROWSER_USE_DISABLE_AMBIENT_NETWORK` override was supplied: the installed LCU default provided it. Chrome 154.0.8037.57 and official extension 1.26.901.11451 passed the original extension/native-host discovery and browser-action suite on both architectures. Checks covered navigation, Unicode typing, Save, screenshots, a local login/cookie/protected-page flow, tab closure, denied-origin blocking before fetch, stale-tab rejection and exact claiming, reset, service restart, and no replay after timeout. Fixture requests contained the original extension's `x-browser-agent` label. The original provider still requested origin approvals.

These latest Linux checks ran in Docker on an Apple Silicon host; x86-64 used emulation. Docker's container seccomp filter was relaxed for Chrome's namespace sandbox; Chrome itself did not use `--no-sandbox`. Earlier AppArmor-enabled physical x86-64 and ARM64 VM results cover earlier artifacts and must not be described as execution of these exact new archives.

The archives contain no OpenAI application tree, `@oai` payload, copied upstream instruction tree, account credentials, Python caches, or Windows launcher. All shipped implementation files that correspond to checkout files matched the reviewed source bytes. Original instruction copies are generated locally from the selected installed application during setup.

Local logs are `/private/tmp/lcu-final-fixed-gate-{arm64,amd64}.log` and `/private/tmp/lcu-final-browser-{arm64,amd64}.log`. Archive generation directories are `.verification/arm64.R20Fb7` and `.verification/amd64.dW44Bu`. Final copies belong under ignored `dist/focused-delivery-2026-09-24/`.

See [macOS final archive checks](macos-final-archive-2026-09-24.md) and [actual harness evidence and limitations](../ADAPTERS.md). A real Codex model saved the Linux native fixture using LCU, but that run used temporary MCP configuration and did not prove the entire installed skill-loading journey. Pi has actual installed-harness scripted tests and a separately checked setup-generated wrapper. Claude Code has registration/fixture evidence, no live model result, and no per-turn cleanup wiring for completion or interruption.

Remaining product gates are macOS Chrome actions, cold helper startup and first-time OS permission delivery; live Claude Code use and its documented lifecycle boundary; and Windows installation/browser wiring plus real Windows execution. The Windows resolver and direct launcher have source/fixture evidence only. macOS native TextEdit actions were verified separately against the same original app; these final package checks did not repeat GUI actions.
