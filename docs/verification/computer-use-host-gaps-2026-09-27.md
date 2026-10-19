# Computer-use host integration gaps, 2026-09-27

The subsequent [implementation plan](../COMPUTER-USE-INTEGRATION-PLAN.md)
and its three linked investigations supersede the initial feasibility limits
in this note. They establish the original event-loop and private-client seams,
the exact locked-use identity gate, and the absence of a standalone exported
approval manager under the current macOS reuse rules.

The current LCU checkout omits several original desktop controls beyond the
macOS preview host. The concrete additional gaps are a per-app stop control,
management of saved app approvals, and the computer-use sound preference.
These have identifiable original implementation paths. None was integrated or
tested against a desktop in this audit.

Sound configuration has a direct preference interface. Per-app Stop can use
the original internal native client from the trusted Sky service. Saved
approval management has no standalone original export and remains blocked
under the strict macOS in-place reuse design. These are source findings, not
new desktop support claims.

## Scope and source identity

The repository baseline is `69c9e583eed8c0055e8a2a6494a49309a704dbb5`.
The selected installed app is `/Applications/ChatGPT.app`, version
`26.924.22138`, build `11645`, bundle ID `com.openai.codex`. The
[sharing-indicator investigation](macos-sharing-indicator-2026-09-27.md)
records the app archive/helper/native-addon identity and host authentication
findings. This audit inspected that same app and current LCU source.

Original source references below are relative to `Contents/Resources/app.asar`:

| Source | SHA-256 |
| --- | --- |
| `.vite/build/main-C5425b_s.js` | `91a68c5f690e60033152a34cf0bf5c4234caeb9ddb47586fd3ef5b017bb29d64` |
| Extracted `worker.js` | `26a596c419c9b67eb10a8a498b483c2722995885ce657eb63b3b7cda896ec8e6` |

Offsets refer to UTF-8 bytes of the inspected sources. They identify evidence,
not compatibility allowlists. Original code remained in private temporary
analysis files; no original implementation or instructions were added to Git.

## Missing controls with concrete original implementation paths

| Capability | Original implementation | Current LCU gap and next boundary |
| --- | --- | --- |
| Live native preview and system sharing indicator | Original native `sky.node` host start/connect/stop functions and signed helper stream; see the separate investigation | No preview host. Reuse needs a main-thread AppKit event loop, connection and presentation lifecycle. Independent loading and authentication prerequisites were checked; live display remains unverified. |
| Stop computer use for a selected app | Main handles `computer-use/stop-application` and dispatches `stopApplication` near byte `4061801`; original worker handles it near `2026071` and sends `ComputerUseIPCAppStopRequest` near `2065216` | No user-facing control. The later audit found an original internal-client request seam. The helper stops that app for the current turn and instructs the assistant to finish; continuing the same turn in other apps is not the promised behavior. No standalone call was performed. |
| List and revoke saved app approvals | Main `Mje.getAppApprovals` / `removeAppApproval` at `1768828` / `1768858`; `bM`, `SM`, `xM` implement storage management near `1761137` | LCU forwards original approval requests but has no management interface for saved grants. The original manager handles `ComputerUseAppApprovals.json` on macOS and the original configuration representation on Windows. Reuse its storage semantics; no personal approval file was read or edited. These are app approvals, not macOS TCC permissions. |
| Configure computer-use sounds | Main `getSoundMode` / `setSoundMode` at `1769380` / `1769408` delegate to original preference helpers near `1768276`; these use the helper's `computerUseSoundMode` preference | No LCU setting for this preference. The missing feature is the control; this audit does not claim that native sounds themselves fail to play. Sound playback remains implemented by the original helper. |

The original sound UI offers `foregroundClicks`,
`foregroundAndBackgroundClicks`, and `off`. Native preview integration also
includes browser-preview updates through `upsertBrowserUsePIPContent` and
`invalidateBrowserUsePIPContent`, plus its click callback. The original host
consumes tool-surface metadata and can request external Chrome tab focus.
These are additional parts of the preview-host gap, not separate capture APIs.

The current [macOS lifetime host](../../lcu/macos_host.py) accepts only session
and turn identifiers and invokes original `SkyComputerUseClient turn-ended`.
It does not expose the controls above. A load-only inspection of the intact
original `sky.node` showed its PiP and shell exports, but no app-approval,
sound-preference, or per-app-stop export. Those controls therefore require their
own original settings/worker integration, not merely calling another PiP export.

The original signed client's read-only `--help` lists `mcp`, `event-stream`,
`computer-history`, `calendar`, `messages`, and `turn-ended`. It does not list
a standalone stop-app or approval-management subcommand. `event-stream --help`
identifies Record & Replay; it is not evidence of a ready-made CUA status feed.

## Existing capability with incomplete setup exposure

Computer-audio recording is already in original Sky. Installed
`@oai/sky/dist/project/cua/sky_js/src/targets/mac/create_client.js` exposes
`start_audio_recording` and `stop_audio_recording` when `SKY_ENABLE_AUDIO=1`.
The original app's launcher admits both that option and
`NODE_REPL_ENABLE_AUDIO` together near main byte `174003`.

[LCU runtime environment](../../lcu/runtime.py) preserves explicit incoming
options. LCU has no audio setup switch, and a harness may filter parent
environment variables before launching MCP. This is an opt-in/setup gap,
not missing native capture code. It is separate from notification sounds.

The maintained [audio adapter](../../adapters/audio-files.mjs) saves exact
returned audio bytes and supplies a file reference. Recorded
[harness tests](harness-results-2026-09-26.md) showed that the model provider
received the path rather than the audio. Sending actual audio requires support
in the managing harness and model provider, not only enabling Sky recording.

## Larger or unresolved integrations

### Embedded browser

The current original provider returns `type: iab` near main byte `2466178` and
binds its session to the conversation near `2472914`. The original
`@oai/browser-desktop/scripts/browser-service.mjs` discovers existing providers
and filters IAB by exact session and build flavor. It does not launch the
desktop provider.

[LCU runtime](../../lcu/runtime.py) defaults available backends to `chrome` and
rejects `--with-browser-host`; [setup](../../lcu/setup.py) also rejects embedded
hosting. The old standalone browser host was deliberately removed. Restoring
an original embedded browser is a larger host-integration project, including
window ownership, session routing, policy and lifecycle. Historical extracted
host experiments do not prove a current solution under the intact-app rules.

### Computer use while the Mac is locked

The installed app contains the original `Codex Computer Use Installer.app`
inside the signed helper's `Contents/SharedSupport`. Main settings expose
`getLockedUseState` / `setLockedUseEnabled` near bytes `1769444` / `1769529`;
the original installer adapter uses `status`, `install`, and `uninstall` near
`1767220`–`1768276`. LCU does not expose that setup.

The [official OpenAI documentation](https://learn.chatgpt.com/docs/computer-use#locked-use)
describes an authorization plug-in for trusted computer-use turns. The later
[native investigation](macos-locked-use-feasibility-2026-09-27.md) identifies
the exact responsible-host identity check. Signed Node alone is insufficient;
the sender must be attributed to an allowed original Codex host. Installer
presence does not grant that identity. The installer was not run and no lock
state was changed.

### Cloud credential handoff

Original browser credential handoff requires
`runtime.gaas.getBrowserAuthBrokerChallenge` and an environment-specific broker.
The inspected implementation constructs that adapter for
`gaas-browser-environment`. No locally reusable desktop broker was established;
this is not a setting LCU can simply enable.

## Items checked that are already connected

- macOS native turn-end cleanup is now wired through
  [macos_sky_service.mjs](../../lcu/macos_sky_service.mjs) and the lifetime host.
  Its [verification record](macos-cursor-lifecycle-2026-09-27.md) distinguishes
  command delivery from still-unverified visible cursor cleanup.
- Original browser cleanup registers the runtime's turn-ended handler, and
  maintained adapters send it the host's session/turn identifiers.
- External-browser downloads, uploads and available browser/tab capabilities
  remain in the unchanged original browser service. WebMCP and raw CDP retain
  original configuration and policy checks. This audit found no missing LCU
  implementation for them; availability still depends on provider and policy.
- Original app metadata/results are retained by adapters. Rendering app cards,
  mentions or task status in another agent's UI is managing-harness integration,
  not an omitted screenshot or action API.
- The original desktop's permission-request path performs an app observation;
  it is not a newly discovered passive macOS permission-status API. The existing
  [onboarding evidence](macos-permission-onboarding-2026-09-27.md) still applies.

## Verification limit and next action

This initial note records source and metadata/help inspection. The follow-up
native report separately records a mistaken service `--help` launch that
aborted immediately and proves no desktop behavior. No settings mutation,
approval mutation, installer execution, or new desktop test occurred. This is
not proof of parity on other platforms.

Connect the original per-app Stop path alongside the preview host, then test
both on an isolated macOS fixture before marking either supported. Expose the
sound preference through its existing contract; saved approval management
requires an original reusable entrypoint.
