# Native default and optional Chrome, 2026-09-24

Implemented with three Sol agents. Production source is `e7b527292fbe0519373b945a0f2281264db9cbd9`; subsequent commits only refine tests and documentation. Original application files were not changed.

## Behavior

- Bare `lcu` selects the original `computer` surface. The original launcher omits its browser service, browser methods and browser-specific tool description. The shared original core guide still contains browser examples; its bytes are not rewritten.
- `lcu setup --agent pi|codex|claude-code --yes` installs native tools/instructions without copying Chrome references, registering a native host, inspecting Chrome profiles or warning about an absent extension.
- Interactive setup offers Chrome with a default of No. `--chrome` is the explicit noninteractive option, accepted by setup and both supported installers. It registers `lcu --chrome`, invokes the app's original native-host installer through the existing LCU integration, and copies applicable original browser and Chrome plugin documents byte for byte.
- The original Chrome plugin skill remains a reference for its separate entry point. LCU continues to use unified `cua`; no second Chrome API, engine, skill rewrite or harness-specific Chrome adapter was added.
- Chrome itself must confirm installation of the official Web Store extension. LCU prints the original diagnostic/store guidance; it does not silently install or enable an extension. OS and site approvals remain active.
- Returning an agent to native mode removes its browser command flag and guidance. It does not uninstall a previously selected account-level connector that other clients may use.
- `--export --chrome` also configures the local account's connector and produces a portable command preserving `--chrome`. The export contains bootstrap metadata, not original app files or copied instructions. Direct clients use `lcu --chrome` after `lcu browser install` and extension setup.

The source seam is the pinned app's `@oai/cua-repl` launcher (`CUA_REPL_ENABLED_SURFACES`) and `@oai/cua` tinysky globals. Original method probes confirmed `getApp` is present and `createBrowserTab` absent for `computer`, with both present for `browser,computer`. See the [component audit](chrome-plugin-architecture-2026-09-24.md) and [instruction inventory](../INSTRUCTIONS.md).

## Exact development archives

All three archives contain the implementation above. A byte comparison of their LCU runtime, installer, adapter, skill and launcher source files against the final tree passed. Later documentation changes are not in these archives. No version bump, release publication or new tag was performed.

| Archive | SHA-256 |
| --- | --- |
| `lcu-0.3.0-linux-arm64.tar.gz` | `99504fe901bdf96bebea93ff48abc568b6a961ddde981e65dcdb499f68a1969c` |
| `lcu-0.3.0-linux-x64.tar.gz` | `118365e9633fe38d1d87a2ab482f43bf92177fa14f5b23814ecea61c578b7239` |
| `lcu-0.3.0-darwin-arm64.tar.gz` | `ab5dced7c52e3fc9df769ec7394ab3deed723a439a5806b9f2c92fedaa988332` |

Archives and checksum sidecars are retained locally under ignored `dist/chrome-opt-in-2026-09-24/`. They contain no OpenAI application binaries or copied upstream instructions.

## Linux evidence

Both architectures passed the offline installer/registration/native gate: 104 Python checks, corrupted-package and concurrent-installer checks, Pi/Codex CLI/Claude Code registration in user/project scopes, ownership, idempotency, configuration preservation, native-only default, explicit Chrome registration, byte-identical references, and portable exports. Native GTK actions passed with no surface environment override: accessibility, Unicode typing, keys/paste, independent saved-file oracle, window isolation, screenshots, errors, reset and timeout recovery. The actual default API had no `createBrowserTab`.

Both exact archives then passed Chrome opt-in in network-disabled disposable Docker fixtures. Tests ran `setup --export --chrome`, then literal `lcu --chrome` without ambient surface settings. They checked original extension discovery, navigation, Unicode input/save, screenshot, fixture login/cookies, denied-site blocking, stale and closed tabs, reset/restart, timeout without replay and the website-visible agent header. Chrome was 154.0.8037.57; the pinned official extension was 1.26.901.11451. Installing the extension/connector did not make browser methods available to bare `lcu`.

These runs used Docker on Apple Silicon, with x86-64 emulation. Chrome's sandbox stayed enabled; the test container's seccomp filter was relaxed for its namespaces. These are not new physical-x86/AppArmor results.

Commands: `tests/run.sh linux/arm64 <verified-arm64.deb>` and the amd64 equivalent; the same candidate archives were installed into disposable existing Chrome fixture images, followed by `tests/browser_session.sh`. Logs remain in `/private/tmp/lcu-chrome-optin-{arm64-rerun,amd64,browser-arm64-fresh,browser-amd64}.log`.

One new native assertion initially parsed Node's object display as JSON. The test was fixed to emit explicit JSON and the gate passed with the same archive; no product change was needed. One old ARM64 browser fixture's managed app failed integrity validation. A fresh prefix installed from the verified official package passed; the integrity check was not bypassed. Original failure logs remain available.

## Live macOS evidence

The Darwin archive installed under `/private/tmp/lcu-chrome-optin-install` using the pinned signed `/Applications/ChatGPT.app` 26.917.62051 in place. Original-versus-LCU MCP initialization, tool descriptions/schemas, macOS instructions, persistent JavaScript and reset matched. `tests/macos_setup.py` passed both modes in disposable homes: native references/command only by default; original browser and Chrome plugin references byte-identical plus `--chrome` after opt-in. No personal harness configuration was changed.

The user explicitly authorized personal-laptop testing and extension installation. **LCU itself**, using its original native `cua.getApp` path, clicked Chrome's official extension installation confirmation in the existing signed-out “LCU disposable test” profile (Profile 4). The built-in Codex computer-use tool was not used for this work. The original connector installed successfully, and its original diagnostics reported the enabled extension and matching connector.

The final archive's default runtime read Chrome through the native app API and confirmed `createBrowserTab` was undefined. A separate final-runtime `lcu --chrome` session then opened a new tab through the extension, typed `LCU opt-in final verified — Café 日本語`, clicked Save, observed Saved and returned a screenshot. The independent loopback HTTP fixture wrote the exact text and observed `x-browser-agent: ChatGPT/<test session>`. Only the exact fixture origin `http://127.0.0.1:8765` was approved. The LCU process used a new empty `CODEX_HOME`; no credentials were copied or login performed. This was a shared-SDK client driven by this agent, not a new Pi/Claude/Codex CLI model session.

Evidence is local under `/private/tmp/lcu-chrome-optin-live/`, including final native/browser responses, screenshot, saved file and server request records. Test tabs and the local server were closed. The authorized extension remains in the disposable Chrome profile, and the original connector remains registered for this account. The signed native helper was already running; it was not stopped or replaced.

## Boundaries still open

This completes the default-off/Chrome-opt-in change and supplies the previously missing live macOS Chrome action proof. Later independent [Pi native-model](pi-generated-gtk-real-model-2026-09-24.md) and [interactive Codex Chrome](codex-interactive-2026-09-24.md) runs close those harness-specific gates for their isolated Linux fixtures. Windows live verification, cold macOS helper startup/first-time OS permissions, and Claude Code turn cleanup remain separate gates. The Linux no-account fixtures and the macOS running-desktop checks establish different boundaries; do not claim full three-platform parity.
