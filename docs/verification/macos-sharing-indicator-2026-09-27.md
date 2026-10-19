# macOS window-sharing indicator, 2026-09-27

The original Codex tool displayed the supplied purple window-and-person badge
on the `LCU macOS cold helper test` UTM window during this investigation.
Static native call tracing identifies a separate live Picture-in-Picture
window stream behind the app's capture UI. LCU reuses the helper but does not
initialize its desktop Picture-in-Picture host. The native stream path requires
a connected host; sharing the helper alone is insufficient.

This replaces the initial investigation's expectation based only on helper
reuse and binary symbols. The findings below distinguish observed UI from
static control flow. No live LCU badge result is claimed.

## Primary evidence

Apple's [ScreenCaptureKit WWDC23 session](https://developer.apple.com/videos/play/wwdc2023/10136/)
explains that each SCStream integrates with system sharing UI, including a live
preview and controls to replace or end the stream. It separately describes the
SCScreenshotManager API for single screenshots without creating an SCStream.
Apple's [macOS 15 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)
identify a purple window menu and its stop-recording control for window
recording streams. Neither source establishes which Codex request starts or
stops a stream.

The inspected local app at `/Applications/ChatGPT.app` reports ChatGPT
`26.924.22138`, build `11645`, bundle ID `com.openai.codex`. Its embedded
`Codex Computer Use.app` reports `26.923.1001242`, build `1001242`, bundle ID
`com.openai.sky.CUAService`. Its executable is `SkyComputerUseService`.
The preceding [app verification](macos-current-app-2026-09-26.md) records
app/helper signature validation; this investigation did not repeat those
checks. The separate bundled Node signature check is recorded below.

The following hashes identify inspected inputs only, not compatibility
allowlists:

| Original file | SHA-256 |
| --- | --- |
| Helper `SkyComputerUseService` | `40ff57cbce8dff6e0e2d4f66fc3df2ec75abd915d9489d67316e4a094cf8307a` |
| `Contents/Resources/native/sky.node` | `ccea345878ec005b069f5989612f351f7a20ec5749a3f1e59f4b80eeea0da0b5` |
| `Contents/Resources/app.asar` | `d0ba973179d2f717affd39e012b64a095464a54a51c6bccb7bc6b3d2a1cfba80` |

## Traced native behavior

Read-only ARM64 disassembly and Swift/Objective-C metadata establish the
following paths in this exact executable. Addresses are unslid virtual
addresses. The analysis never launched a debugger against the running helper.

1. Original `@oai/sky/dist/project/cua/sky_js/src/targets/mac/get_app_state.js`
   calls `MacComputerUseClient.getAppState`; `client.js` sends
   `ComputerUseIPCAppGetSkyshotRequest` through original `native-pipe.js`.
2. The native request handler activates the app controller at `0x100156ddc`
   and requests its updated skyshot at `0x100157090`.
3. Screenshot production follows `SkyshotOperation.captureScreenshot` to
   `SlimCore.ScreenshotImplementation.captureScreenshotBuffer`, ultimately
   calling `SCScreenshotManager.captureImageWithFilter:configuration:completionHandler:`
   at `0x100eac250`. This is a single-image capture call.
4. Updating the skyshot also posts
   `computerUseAppControllerDidUpdateSkyshot` at `0x10006dd44` or
   `0x10006e4cc`. `CUAServiceRemoteHostedPIPController` registers for this
   notification at `0x1000312fc`. Its handler requires an active turn and a
   window, then calls `publishWindowStream(threadID:turnID:windowID:)` at
   `0x10003285c`.
5. The registered authenticated-request preparation callback reads `CodexComputerUseTelemetryContext.snapshot()`
   at `0x1000295c8`, obtains the session/turn IDs, and updates the active turn
   at `0x100029764` when its request-classification boolean is true. Server
   startup registers the callback at `0x100027684`; the server stores it at
   `0x100179644`. The dispatcher enables it for its private app-usage request
   protocol and list-apps/audio requests. The exact get-skyshot conformance to
   that private protocol was not resolved. This leaves the complete metadata
   activation trace for that specific request unfinished. The helper also
   gates creation of this PiP controller on its `remoteHostedPIP` feature flag.
6. Publishing the stream queues work that reads
   `RemoteHostedPIPContentPublisher.connection`. The branch at `0x1001e5954`
   returns when that connection is absent, before constructing the renderer.
7. With a connection, the path constructs `RemoteHostedPIPWindowRenderer`
   through `0x1001f385c`. Its start path constructs `SCStream` at
   `0x1001faa80`, then calls `startCaptureWithCompletionHandler:` at
   `0x10005c6a4`.

Thus an ordinary app observation produces a single screenshot and notifies
the separate PiP machinery. With an active turn, valid window, enabled feature,
and host connection, the traced path starts an independent live window stream.
The separate `ComputerUseIPCAppStartCaptureRequest`
symbol is not needed to explain this path; in the desktop JavaScript it belongs
to the appshot bridge.

## Desktop host and LCU

Original `app.asar` entry `.vite/build/main-C5425b_s.js` contains the macOS
PiP manager `zue` at UTF-8 byte offset `410012`. It loads the original
`Resources/native/sky.node`, starts `startRemoteHostedPIPContentHost`, and
connects the helper PID through `connectRemoteHostedPIPContentHost`. It also
supplies presentation and turn-completion/invalidation handling.

The renderer's stop path clears its capture references and calls
`stopCaptureWithCompletionHandler:` at `0x10005ca50`. Every route from
completion, interruption, and disconnection into that stop method was not
traced. This investigation therefore does not establish an exact badge
disappearance time.

The native addon manages the presentation host and XPC connection. The helper
owns the `SCStream`. Stream creation precedes the host's presentation-visibility
callback, so a hidden preview must not be equated with no active capture.
The JavaScript visibility callback accepts a nonempty task ID without requiring
that ID to exist in the desktop app's conversation catalog.

[LCU runtime.py](../../lcu/runtime.py) selects the original helper through
`SKY_CUA_SERVICE_PATH`, executes the original CUA REPL, and supplies default
session/turn metadata when the caller does not. The original client forwards
`x-codex-turn-metadata` into native request metadata. LCU does not load
`sky.node` or start/connect this macOS PiP host.

Consequently, standalone LCU does not establish the host connection required
for this stream path. LCU can reuse the per-user helper while the original
desktop host is already connected; that case has a different connection state
and must not be described as a standalone result. The call trace establishes
the conditional path, not a completed live LCU comparison.

There is a concrete upstream integration point for future work: the original
host start/connect/stop and lifecycle functions. The loading and authentication
findings below establish an integration route outside the main app; operating
the host still requires an isolated desktop integration test. No separate
screenshot implementation or synthetic badge is justified.

## Standalone host feasibility

A load-only probe used the intact installed
`Contents/Resources/cua_node/bin/node` to require the intact
`Contents/Resources/native/sky.node`. It succeeded under Node `24.21.0`, with
no Electron runtime, and exported `startRemoteHostedPIPContentHost`,
`connectRemoteHostedPIPContentHost`, and `stopRemoteHostedPIPContentHost` as
functions. The probe did not start a host, connect to the running helper, or
capture a window.

Read-only tracing identifies these authentication and hosting requirements:

- The helper's PiP bootstrap handler at `0x10017baf4` invokes common sender
  authentication at `0x10017bb2c`. Its team check accepts `2DC432GLL2`,
  `HX7739G8FX`, or the helper's own team. The main app's bundle identifier is
  not a requirement of this PiP bootstrap path.
- The handler validates the protocol version at `0x10017bbc0`. The original
  addon supplies that version in its bootstrap message.
- At `0x10017bbd4`–`0x10017bbe4`, an app-owned helper additionally requires
  the sender's PID to match its lifecycle owner. A helper in standalone
  lifecycle mode skips that owner-PID restriction. An independent host must
  therefore use the proper helper lifecycle rather than assume it can take
  over the user's app-owned helper.
- The subsequent XPC listener at `0x1001ecc30` accepts the connection;
  acceptance leads to storing the publisher connection at `0x1001e38f0`.
- The addon start wrapper requires the main thread, five tooltip strings,
  and a connection-loss callback. Standalone hosting must supply the AppKit
  event loop and host lifetime wiring normally supplied by the desktop app.
  Its main-thread check is at addon address `0x56b0`; rendezvous dispatches
  connection completion onto the macOS main queue at `0x12924`–`0x1292c`.
  No event-loop runner was found in the addon. Loading it alone therefore
  does not establish a working standalone host.

`codesign -dv --verbose=4` reports TeamIdentifier `2DC432GLL2` for the original
bundled Node. `codesign --verify --strict --verbose=2` passed outside the
tool sandbox, reporting both valid on disk and satisfaction of its Designated
Requirement. The same check inside the tool sandbox returned an invalid
signature error; no executable was modified between checks.

These findings rule out a main-app identity requirement at module loading
and PiP bootstrap authentication when using the intact signed runtime and a
standalone helper. They do not prove a functioning standalone preview. LCU
does not yet supply the main-thread/AppKit host and lifecycle wiring, and no
end-to-end LCU badge result has been observed. Reusing the original components
is the next implementation experiment; a live isolated test must precede a
feature-support claim.

## Live observation and remaining blocker

The existing task-owned UTM guest `34461462-A64A-4740-9A68-458E1748EB15`
was stopped and was started for this investigation. Guest execution through
`utmctl exec` reports that the Apple backend does not support the operation.
SSH to its DHCP address `192.168.64.5` reports connection refused.

Original Codex `cua.getApp('UTM')` followed by `getScreenshot()` showed the
exact badge on the test VM viewer's host titlebar. The guest itself was at the
`lcu test` password screen. This is an original-tool observation of the VM
viewer, not evidence of LCU running in the guest. An attempted read of the
badge menu returned `noWindowsAvailable`; no menu result is claimed. The user
was asked to unlock the test guest. No credentials were searched for or copied.

No LCU runtime code changed. Existing platform support and verification limits
are unchanged. Native disassembly and extracted host source stayed in private
temporary analysis directories; no original implementation, instructions, or
generated fragments were added to Git.

## Next verification

In a disposable macOS desktop, compare the original app and LCU against the
same fixture window. Observe the badge during initial app observation, native
actions, background/Picture-in-Picture use, normal completion, interruption,
and connection shutdown. Use the system sharing UI to identify the capturing
process and observe when capture ends. If behavior differs, trace and reuse
the missing original host service or lifetime wiring. Keep capture and system
UI behavior in the original helper; record an unresolved dependency as a
parity blocker.
