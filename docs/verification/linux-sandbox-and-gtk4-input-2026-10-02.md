# Linux sandbox state and GTK 4 input

Date: 2026-10-02. Origin: a live Silo verification on an x86-64 Ubuntu 24.04 guest (Xfce on Xvfb, LCU 0.8.1 installed in place against a read-only ChatGPT 26.928.31416 app, MCP driven by a bare stdio client). Two symptoms were reported. Everything below was reproduced in disposable Ubuntu 24.04 containers with scripted providers and local fixtures only; no real harness configuration, account or desktop was used. The ChatGPT package was read from a local .deb for inspection and is not redistributed.

## 1. `js` fails with "Could not connect to X11 ... Operation not permitted"

Root cause (LCU 0.8.1): the original `node_repl` probes for a working Codex sandbox at start (`codex sandbox ... /bin/sh -c 'test -r /etc/os-release || exit 10; touch "$1" && exit 11; exit 12' node-repl-sandbox-probe`). Where the probe works (bubblewrap and user namespaces available, as in a normal VM), it advertises the `codex/sandbox-state-meta` capability and runs both the JavaScript kernel (`kernel.js`) and the trusted Sky worker (`trusted-worker.js`) under `codex sandbox` with `filesystem = {":root" = "read", ...}` and `network = {enabled = false}` unless the caller sends `_meta["codex/sandbox-state-meta"]`. The network filter is a seccomp rule that refuses `connect(2)`, including to the X11 Unix socket, so Sky returned `IoError(Os { code: 1, kind: PermissionDenied })`. `lcu doctor` passed because it imports the Sky service in a plain Node process and never goes through `node_repl`. Docker's default profile prevents the probe from succeeding, so no earlier container gate ever ran with the sandbox active.

Observed with the app's own Codex CLI recording its command lines (`CODEX_CLI_PATH` wrapper), sandbox active:

| Per-call `codex/sandbox-state-meta` | Result |
| --- | --- |
| none | sandboxed, network disabled, X11 refused |
| `permissionProfile: {type: "disabled"}` | no `codex sandbox` wrapper; X11 works |
| `{type: "external", network: "enabled"}` | still sandboxed with `network = {enabled = false}` |
| `{type: "managed", file_system: {type: "unrestricted"}, network: "enabled"}` | still `network = {enabled = false}`; `:root = write` (and a `crosses writable symlink` failure for LCU's release `app` link) |
| `{type: "managed", file_system: {type: "restricted", ...}, network: "enabled"}` | still `network = {enabled = false}` |

Only a disabled profile removes the wrapper; the profile's network field is ignored by this build. `NODE_REPL_REQUEST_META` carrying the same key behaves like a default: a per-call value overrides it, and a call without one falls back to it (a strict per-call profile gave the X11 error, the next call without it worked).

What harnesses send, measured with Codex CLI 0.159.1 and a recording server that advertises the capability (`tests/codex_sandbox_state.py`):

| Registration | read-only | workspace-write | danger-full-access |
| --- | --- | --- | --- |
| Codex registered directly with the server | managed, filesystem restricted, network restricted | managed, filesystem restricted (project, /tmp, TMPDIR writable), network restricted | disabled |
| Codex through `adapters/codex.mjs` | nothing | nothing | nothing |

The Codex relay does not advertise the capability, so Codex never sends it through the relay. Claude Code, Pi, Oh My Pi, the Hermes bridge and generic MCP clients are not known to have such a feature and LCU's code sends nothing for them (the shared client and both relays add only `x-codex-turn-metadata`). So every LCU adapter and bare client was affected on a sandbox-capable machine, and a registration of bare `lcu` in Codex CLI would send a restricted managed profile under its default modes.

Fix (0.8.2): on Linux, `lcu` adds `codex/sandbox-state-meta = {permissionProfile: {type: "disabled"}, sandboxCwd: <launch directory file URI>}` to `NODE_REPL_REQUEST_META` (merged into a host-supplied value only when the key is absent). This is the state official Codex sends under `danger-full-access`, supplied through an original, documented-by-behavior option instead of a request proxy. A per-call or host-set value wins, so a host that sends a stricter profile keeps it. `LCU_NODE_REPL_SANDBOX=host` declines the default. See [adapters](../ADAPTERS.md#linux-sandbox-state).

Regression coverage: `tests/test_runtime.py` (default, precedence, merge, opt-out, other platforms) and, in the Docker gate with the sandbox active (`seccomp=unconfined`, `apparmor=unconfined`, `SYS_ADMIN`, plus a read-only app mount), `tests/desktop.sh` runs the original GTK suite and `tests/adapter_paths.py`: the GTK save-oracle flow through a bare client, the Codex relay, the Claude relay, the shared client used by Pi and Oh My Pi, and the Hermes bridge, each with no sandbox metadata and with `turn_ended` followed by another call. With `LCU_REQUIRE_SANDBOX=1` it first asserts the capability is advertised, that declining the default reproduces `Could not connect to X11`, and that a strict per-call profile still does. Against the unfixed 0.8.1 release the unmodified GTK suite fails with the reported error under the same container flags.

## 2. GTK 4: `pressKey` and coordinate clicks do nothing

Root cause: the original engine's behavior, not an environment problem and not something LCU controls. The Linux engine (`sky_linux`) sends window-targeted input as core X events with `XSendEvent` to the target window "without activating it" (`BackgroundWindow::send_event`, `BackgroundSession::send_focus`; the Sky type documentation says "Linux sends input without activating it. Omit for desktop input"). `app.pressKey` and coordinate `app.click` always pass the window. GTK 3 accepts those events. GTK 4 reads input only through XInput2 and ignores synthesized core events. AT-SPI actions, `typeText` and `paste` do not use this path (they use AT-SPI `PasteText`/`DoAction`), which is why they worked where the engine supports them: `typeText` inserted on 26.928.31416 but returned success without inserting on 26.915.31945 (see below).

Reproduction with gnome-text-editor `--standalone` and a GTK 4 fixture under Xvfb with XTEST, with no window manager, Xfwm4 and Openbox:

- `xdotool key ctrl+a`, `BackSpace`, `Return` and a pointer click (XTEST) work in all three setups, with the default `us` evdev keymap.
- `xdotool key --window <id> ...` and `type --window <id>` (XSendEvent) change nothing in GTK 4.
- Through LCU: `app.pressKey("ctrl+a")`/`BackSpace` and window-targeted coordinate clicks return without error and change nothing. The low-level desktop calls with no `window` work: `await sky.activate_window({window}); await sky.press_key({key: "ctrl+a"}); await sky.click({x, y})` with desktop coordinates.
- `typeText` depends on the engine version. ChatGPT 26.928.31416 inserts through AT-SPI (a GTK 4 text view may then raise `org.a11y.atspi.Text.SetCaretOffset ... NotSupported` after the text was inserted); 26.915.31945 returned without error and inserted nothing into a GTK 4 entry.

`tests/gtk4_input.py` (GTK 4 fixture `tests/gtk4_fixture.py`) asserts the paths that work in both app versions (desktop-level text, keys, Return, coordinate click) and prints the `typeText` and window-targeted results as information (`keys not delivered, coordinate click not delivered` here), so a change in the original engine appears in the log without failing the suite. LCU 0.8.2 changed nothing for this. Update: LCU 0.8.3 re-issues window-targeted GTK 4 input through the engine's own desktop-level calls (see [the translation record](linux-input-translation-2026-10-02.md)); the original input implementation remains authoritative and no replacement is added.

## Requirements for a guest image or session (Silo)

- No change is needed for sandbox state: LCU 0.8.2 supplies it. Leave user namespaces and bubblewrap as they are; they no longer matter to computer use. Keep `LCU_NODE_REPL_SANDBOX` unset.
- Xvfb or the X server must keep the XTEST extension (the default; never pass `-extension XTEST`) and Composite for screenshots. Any EWMH window manager works (Xfwm4 verified); it must support `_NET_ACTIVE_WINDOW` for `activate_window`.
- AT-SPI: `at-spi2-core` and its session bus must run for the account, with `NO_AT_BRIDGE` unset or 0. GTK 4 apps need no extra module; GTK 3 apps use `GTK_MODULES=gail:atk-bridge`.
- Keyboard: no XKB package or flag beyond the usual `xkb-data` is required; the engine resolves keysyms with `XKeysymToKeycode`. The key syntax is `ctrl+a`.
- Agent guidance for GTK 4 (and any XInput2-only toolkit): use AT-SPI actions, `typeText` and `paste` first; for keys and coordinates, activate the window and use the low-level desktop `sky.press_key`/`sky.click` calls shown above.

## Evidence

ARM64 (native) and AMD64 (emulated) container gates are recorded in the [0.8.2 release notes](../releases/0.8.2.md).
