# Headless computer-use integration status

> **Historical planning record (2026-09-28). Superseded by [AGENTS.md](https://github.com/0xpolarzero/lcu/blob/main/AGENTS.md) and [docs/INSTALLATION.md](INSTALLATION.md); do not follow its instructions.** The `.verification/...` paths cited below are private local evidence and are not in the repository.

Updated 2026-09-28 after guest recovery, macOS audio acceptance, and the live
browser-tab picker check. The
sections below distinguish proven behavior from remaining live integration
gaps.

LCU remains a headless adapter to the installed original runtime. Do not build
or launch an LCU GUI companion, preview window, or menu-bar app. Direct users
to the installed ChatGPT app for computer-use approvals and preferences.

## Delivered scope and verification

### 1. Request context: implemented

Files: [client.mjs](../adapters/client.mjs),
[Pi extension](../adapters/pi/index.ts), and
[Claude relay](../adapters/claude.mjs).

The adapters now forward each actual request ID and available host
thread/source/model fields through relay mode. Unavailable identities remain
absent. Focused adapter tests cover distinct calls, Pi's execution ID, Claude's
tool-use ID, and relay preservation. This does not establish additional
desktop approval UX.

### 2. Headless Stop: same-turn effect and fresh-turn recovery verified; UI flow open

The Pi extension registers `/lcu stop`. It uses the private bounded host-control
transport and original macOS client. The ordinary harness cancellation path
and turn-end cleanup remain in place. There is no model-facing Stop tool or
universal cross-harness UI. A task-owned macOS guest proved the private bridge
can stop TextEdit between native calls in the active turn; the Pi slash-command
UI itself has not been exercised end to end.

User effect: stop computer use for an active app from the harness. Original
behavior marks the app stopped for the current turn and tells the assistant
to finish; it does not revoke the saved app approval.

Focused disposable-container tests cover the service/host protocol, bounded
cleanup retry, and original turn metadata. On the recovered guest, accepted
AppStop caused the next native action in that turn to return the original
stopped-for-this-turn error. The real turn-ended hook sent the original
`ComputerUseIPCCodexTurnEndedRequest` with the captured session, turn, and
metadata, then retained the existing CLI cleanup; a distinct new turn recovered
and saved the exact 39-byte fixture. The run used no approval or provider
request. Two final guest runs also accepted Stop while a `type_text` MCP call
was pending; the call returned the original stopped-for-this-turn error, the
next same-turn action was rejected, and a fresh turn passed the file oracle.
This proves the pending MCP call's result semantics, not interruption of native
typing at a specific keystroke boundary. The Pi `/lcu stop` menu remains
untested end to end. See the [current Stop record](verification/headless-stop-implementation-2026-09-27.md)
and the [recovery history](verification/macos-test-guest-recovery-2026-09-27.md).

### 3. Computer-audio opt-in: implemented; platform/model limits remain

Files: [setup.py](../lcu/setup.py),
[setup_clients.py](../lcu/setup_clients.py), and
[runtime.py](../lcu/runtime.py). Keep original approval/capture code and
[audio-files.mjs](../adapters/audio-files.mjs) exact-byte file preservation.

Configuration tests cover all three maintained registrations and portable
exports, paired runtime flags, default-off behavior, and caller environment
preservation. The disposable Linux ARM64 differential and generated-tone
capture passed. A recovered Apple Virtualization guest also passed original
and LCU opt-in capture through the signed app's audio approval and loopback
path, returning exact WAV bytes. See the [audio verification record](verification/audio-opt-in-2026-09-27.md).
The maintained host harnesses do not accept audio content as model input in
the tested path. Pi 0.87.1, both tested Codex CLI versions, and Claude received
the exact saved WAV file reference, not WAV bytes. Audio capture and exact-byte
preservation are verified; model/provider audio input is unsupported by these
host result contracts. See the [host result matrix](ADAPTERS.md#same-case-result-forwarding)
and [audio verification record](verification/audio-opt-in-2026-09-27.md).

### 4. Pi app/tab picker: native and browser paths live-tested

The Pi extension registers `/lcu pick`, which is available while idle. It uses
original app/browser discovery, offers exact app and tab identities, checks the
selection again before adding context to the existing Pi editor, and keeps
browser inventory separate from the original `openTabs` call. It does not claim
that prompt context enforces future model revalidation or reproduce Codex
mention links. Other Pi activity rendering and expanded approval UI were not
implemented.

Files: [Pi extension](../adapters/pi/index.ts).

Executed adapter tests cover original discovery calls, profile/tab identity,
stale selection rejection, editor insertion, overlap, and cleanup retry. A
network-disabled Linux ARM64 fixture ran Pi `0.87.1` against a current-source
LCU build and the original ChatGPT `26.915.31945` / CUA
`0.0.16/20260915001755-492f19756c31` runtime. Pi's real terminal dispatcher
opened `/lcu pick`, showed original native app IDs, and inserted guidance for a
selected app into an existing editor draft without submitting it. The picked
apps were not launched. The native inventory returned 20 apps. This verifies
the native-app picker path on Linux. Browser-tab UI selection remains
unverified by this native-app-only run; its fixture had no browser surface.
A separate live Pi 0.87.1 TUI run against the original Chrome extension
provider selected an open user tab by its exact original profile and provider
tab identity, inserted guidance into the real editor draft, and made no
provider request or tab claim. The captured draft was read through Pi's real
editor API. The run used the final 0.4.2 ARM64 runtime and a disposable,
network-disabled browser fixture; see [request-context verification](verification/request-context-2026-09-27.md#live-browser-tab-picker-tui).
macOS picker inventory remains unverified. No preview or accessibility
implementation was added.

### 5. Settings and verification

Settings remain managed in the installed ChatGPT app. `tests/run.sh` passed in
disposable Linux ARM64 and amd64 containers using the existing verified local
ChatGPT 26.915.31945 / CUA 0.0.16 fixture packages. Both gates ran from the
current checkout after the Pi picker guards and macOS native turn-ended hook
change and passed all 197 Python tests, offline installation, setup,
registration, portable export, and the network-disabled X11 desktop fixture.
The 0.4.2 generated release archives are preserved at
`.verification/arm64.DExN9x/lcu-0.4.2-linux-arm64.tar.gz` (SHA-256
`fb41ea062e5c78707a130b553c1864e57cd206508d0294ffa9c8a38e353efd00`) and
`.verification/amd64.dyem7W/lcu-0.4.2-linux-x64.tar.gz` (SHA-256
`0cdf716dc85b513e0d8cea881cf8f6e58c9996bd52321efeaa0dc6e983f3f49b`). The
gates produced these archives before the final docs-only payload refresh. All
4,387 shared non-document files in each refreshed release archive remain
byte-identical to the gate artifact. Current release archive hashes are
recorded in `.verification/release-0.4.2-gates-20260928.txt`; the three
release archives and sidecars are under `dist/release-0.4.2/`. Exact commands,
fixture paths, and pass counts are in the same verification manifest.
These Linux ARM64 and amd64 gates do not expand macOS, Windows, or architecture
support claims.

## Outside this implementation scope

- Native preview panels, their extra sharing stream/indicator integration,
  browser preview click-to-focus, and a new menu-bar app. They require the
  GUI companion the user declined.
- Live Appshot attachments. These need a harness attachment/subscription UI
  beyond the bounded result presentation planned above.
- Locked-Mac use, embedded IAB hosting, secure credential-broker integration,
  and cloud browser provisioning. Their original host/service prerequisites
  are not supplied by this plan.
- Record & Replay, Computer History, and Messages. These are separate original
  plugins, not part of this headless CUA improvement pass.

## Evidence and confidence

The source audit covered the installed macOS ARM64 app at
`/Applications/ChatGPT.app`, version `26.924.22138`, build `11645`, original
CUA runtime `0.0.24/20260924074400-f52ea85e2a98`, against LCU baseline
`69c9e583eed8c0055e8a2a6494a49309a704dbb5`. These are observed inputs, not
compatibility allowlists.

The three agent reports cover all 46 native exports, 15 computer-use worker
methods, 15 settings-manager methods, 147 browser members across 22 interface
groups, eight browser capability families, and relevant current adapters:

- [Native host and control findings](verification/native-host-integration-plan-2026-09-27.md).
- [Browser, audio and harness findings](verification/browser-runtime-integration-plan-2026-09-27.md).
- [Locked-use boundary](verification/macos-locked-use-feasibility-2026-09-27.md).
- [Original sharing indicator and stream](verification/macos-sharing-indicator-2026-09-27.md).

Those reports preserve findings for features now excluded. They are research
records, not a directive to implement their earlier companion/settings plans.
Source-backed integration paths are not end-to-end support claims. The explicit
desktop gaps above remain open; no GUI/settings port or new platform support
claim was added.

The supported scope is the three original-runtime integrations above plus the
Pi picker and `/lcu stop` action. The browser-tab picker TUI, macOS original
and LCU audio capture, and Stop between native actions with fresh-turn
recovery passed in isolated fixtures. A pending MCP call returned the original
stopped response after Stop, but interruption of native input mid-operation is
not verified. The Pi `/lcu stop` menu itself also remains untested end to end.
The tested host result contracts carry WAV file references rather than audio
bytes to the provider.
