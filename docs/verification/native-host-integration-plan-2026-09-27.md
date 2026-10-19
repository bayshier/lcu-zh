# Original native host integration plan, 2026-09-27

This is a bounded audit of the installed macOS desktop host and its reusable
native components, compared with the current LCU source. It defines integration
seams; it does not claim completed standalone desktop parity. No LCU runtime
code changed.

## Inputs and evidence boundaries

- Installed app: `/Applications/ChatGPT.app`, version `26.924.22138`, build
  `11645`, bundle identifier `com.openai.codex`.
- Helper: installed `cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app`,
  version `26.923.1001242`, build `1001242`.
- Original source: `app.asar/.vite/build/main-C5425b_s.js`, `worker.js`,
  `src-BSSLXJxP.js`, and the computer-use settings renderer modules.
- Native addon: installed `Contents/Resources/native/sky.node`.
- Original Objective-C bridge: installed
  `Contents/Resources/app.asar.unpacked/node_modules/objc-js`.
- Original client: installed `@oai/sky/dist/project/cua/sky_js/src/targets/mac`.

Offsets below are zero-based JavaScript character offsets, not UTF-8 byte
offsets. Native addresses are unslid ARM64 addresses in these inspected files.
Names and offsets identify evidence, not an app-version compatibility allowlist.
Original source extraction and native disassembly remain in private temporary
directories; this document contains findings rather than original source.

An import-only probe used the installed signed `cua_node/bin/node` (`v24.21.0`)
to load `sky.node`, import `objc-js/dist/index.js`, and import the original
`targets/mac/client.js`. All succeeded outside Electron. The probe enumerated
exports/prototype methods and called no desktop methods. The Objective-C bridge
native library reports TeamIdentifier `2DC432GLL2`, matching the bundled Node.
The sandboxed Node entitlements inspection reported an invalid entitlement blob;
this report does not infer an entitlement grant from that output. The actual
library loads, and prior outside-sandbox signature validation recorded in
[the sharing investigation](macos-sharing-indicator-2026-09-27.md), are the
positive evidence.

One separate probe mistakenly invoked `SkyComputerUseService --help`. It
aborted with exit status 134, no output, after approximately 0.39 seconds. This
was a service launch attempt, not an import-only or static check. It was not
repeated and proves no desktop behavior. No capture, input, settings, approval,
or host-connection operation was intentionally invoked by this audit.

## Complete registries checked

### Computer-use worker: all 15 request methods

The original `qDe.handleRequest` registry begins at worker character 1988039;
the dependency factory `tMe` computer-use branch is around 2212700.

| Methods | Current LCU classification | Original implementation |
| --- | --- | --- |
| `requestPermissions` | Original native permissions remain inherited; the app's setup trigger is absent | Calls get-skyshot for the selected app, not a passive permission query |
| `start`, `watchUpdates` | Appshot attachment presentation is absent; adjacent to agent computer use | Original start-capture and next-capture-update IPC; streams metadata, screenshot and accessibility text to the desktop attachment UI |
| `stopApplication` | Missing user control | Original `ComputerUseIPCAppStopRequest` |
| `statusItemMenuState` | Missing status/menu presentation | Original `ComputerUseIPCCodexStatusItemMenuStateRequest` |
| `skysightStatus`, `skysightStart`, `skysightStop`, `skysightPause`, `skysightResume` | Computer History product, outside core CUA parity | Original history service controls |
| `skysightGetSettings`, `skysightUpdateSettings`, `skysightUpdateObservationPolicy`, `skysightClearHistory` | Computer History management, outside core CUA parity | Original settings/history IPC |
| `messagesSearchChats` | Messages product, outside core CUA parity | Original Messages search IPC |

`handleCancel` in this worker is empty. Sending a worker cancellation message
there is not an original emergency-stop implementation.

### Computer-use settings manager: all 15 methods

`Mje` at main character 1764638 exposes:

| Methods | Classification |
| --- | --- |
| `getAppApprovals`, `removeAppApproval` | Missing management of always-allowed apps; approval enforcement itself is already original |
| `getSoundMode`, `setSoundMode` | Missing preference control for original native click sounds |
| `getLockedUseState`, `setLockedUseEnabled` | Separate locked-use investigation; installer availability does not establish trusted standalone turn eligibility |
| `searchMessagesChats`, `getMessagesReadDecisions`, `setMessagesReadAccessPolicy`, `setMessagesReadDecision`, `removeMessagesReadDecision`, `getMessagesSendApprovals`, `setMessagesSendAllowAllChats`, `removeMessagesSendApproval` | Eight Messages-specific methods, outside core CUA parity |
| `openChromeExtensionInstallPage` | Desktop setup navigation; LCU already has its own installation adapter for the original Chrome component |

### Native addon: all 46 exports

The import-only export enumeration found 28 PiP exports and 18 other exports.

| Exports | Classification and boundary |
| --- | --- |
| `startRemoteHostedPIPContentHost`, `connectRemoteHostedPIPContentHost`, `stopRemoteHostedPIPContentHost` | Missing native preview host lifetime; reusable intact addon |
| `setRemoteHostedPIPContentActiveThreadID`, `setRemoteHostedPIPContentSuppressedThreadIDs`, `setRemoteHostedPIPContentShouldShowTaskHandler`, `refreshRemoteHostedPIPContentVisibility` | Missing preview visibility/session wiring |
| `setRemoteHostedPIPContentMaxDisplaySize`, `setRemoteHostedPIPContentMaxDisplaySizeChangedHandler`, `getRemoteHostedPIPContentLayoutState`, `setRemoteHostedPIPContentLayoutStateChangedHandler` | Preview size/layout preferences and events |
| `setRemoteHostedPIPContentPetWakeRequestHandler`, `setRemoteHostedPIPContentVisibilityRequestHandler`, `setRemoteHostedPIPContentComputerUseCursorLocationHandler` | Desktop companion/presentation notifications; not replacements for native input/cursor handling |
| `setRemoteHostedPIPContentVideoFrameHandler`, `setRemoteHostedPIPContentNativeVideoEnabled`, `setRemoteHostedPIPContentNativeVideoReady` | Native-to-webview video presentation bridge; optional when using original native presentation |
| `setRemoteHostedPIPContentPlacement`, `interactWithRemoteHostedPIPContentPresentation`, `hasRemoteHostedPIPContentAnyPresentation`, `getRemoteHostedPIPContentActiveTaskIDs` | Native preview presentation control/introspection |
| `registerRemoteHostedPIPContentHost`, `unregisterRemoteHostedPIPContentHost` | Attach preview presentation to a visible same-process host window/geometry; native panels do not display without an eligible host |
| `completeRemoteHostedPIPContentThread`, `invalidateRemoteHostedPIPContentTurn` | Preview cleanup on completion/interruption; missing from current standalone host |
| `setBrowserUsePIPContentClickHandler`, `upsertBrowserUsePIPContent`, `invalidateBrowserUsePIPContent` | Browser preview and click callbacks, part of the same preview integration |
| `createStatusItem`, `updateStatusItemMenuState`, `updateStatusItemState`, `destroyStatusItem` | Reusable native macOS menu-bar UI; LCU currently has no desktop menu |
| `spawnComputerUseService`, `computerUseServiceProcessMatchesExecutablePath` | Reusable original managed-helper launch/PID validation; current LCU instead inherits original LaunchServices fallback |
| `frontmostWindow` | Reusable original foreground-app metadata; the agent already inherits app discovery/state, while appshot selection is desktop presentation |
| `iconMediumForAppPath`, `iconSmallForAppPath` | Reusable native UI assets, not additional agent input capabilities |
| `startModifierCapture` | Codex shortcut recorder; desktop-shell feature |
| `getDefaultWebBrowserState` | Desktop browser-window/focus presentation logic; not missing browser automation |
| `startFileDrag`, `setWindowDragTarget`, `performWindowDrag`, `isWindowDragActive`, `finishWindowDrag` | Native drag integration for the desktop app's own windows/files; not absent agent mouse/drag implementation |
| `isPrivacySettingsTerminationRequest` | Desktop `before-quit` handling after privacy settings changes; not a passive permission-status API |
| `reopenNativeApp` | Export exists; no caller was found in the inspected main bundle. No user-facing parity claim is based on it |

### Host-service and native status-event registries

The original host-services schema at main character 322147 admits exactly
one request method, `ensureService`. At 4086816 the desktop registers exactly
one service, `computer-use`, which calls the managed helper's `ensureServicePid`.
Creation is gated on the internal desktop build classification in this source.
No thread identifier, turn identifier, credential, or locked-use grant is in
that request. It is startup coordination, not a demonstrated trusted-turn
channel. The normal original macOS client first tries the helper socket and
uses this channel only if that initial connection fails; otherwise it falls
back to original LaunchServices startup.

The original native menu event schema `Gct` covers menu update/open/close,
quit, open-thread, stop-application, six Computer History actions, and
service-state-changed. `Kct` at main character 4059790 forwards native menu
state changes and dispatches user actions. Thread navigation, main-app quit,
and history routes belong to the desktop shell. The CUA-relevant additions
are active-state display, active-app list, and original per-app Stop.

## Exact integration routes

### One native companion, with the original event loop

Use one LCU native companion per controlled desktop/helper, multiplexing all
LCU MCP sessions. Current `lcu/macos_host.py` starts one lifecycle process per
MCP connection; it must not simply acquire a PiP connection in each process.
The helper publisher holds one host connection and replaces it on reconnect.

Launch the companion using the selected app's signed `cua_node/bin/node` and
load the selected app's intact `native/sky.node` by absolute path. Load the
same app's intact `app.asar.unpacked/node_modules/objc-js/dist/index.js`.
Its existing `RunLoop.run/pump/stop` implementation is documented at
`dist/index.d.ts:284` and implemented at `dist/index.js:665`–741. It pumps
`NSRunLoop.mainRunLoop()` from the Node event loop. The addon requires its
main thread, so do not place PiP hosting in a Node Worker. The original
Objective-C bridge exposes `NobjcLibrary` for Foundation/AppKit application
initialization. No custom compiled event-loop, input, accessibility, or
ScreenCaptureKit implementation is needed for this route.

The ordered host contract is: initialize application/event loop; create an
LCU-owned visible AppKit host window and register its presentation geometry;
register presentation callbacks; start the original host with its five control labels
and connection-loss callback; connect the actual helper PID; publish active
session/visibility information; forward turn completion/interruption; stop
the original host before stopping the original event loop. The main app's
manager `zue` starts at character 410010; `Rc`, `zc`, `Bc`, `il`, and `al`
wrap the relevant native exports. Preserve original native controls and their
meaning. Choosing different window docking/desktop companion presentation is
an LCU shell choice, not permission to replace capture or native controls.

`spawnComputerUseService` accepts only an executable path. Its original
worker at addon address `0x3a9ec` uses `posix_spawn`, disclaims process
responsibility, passes only the executable as argv, and inherits the process
environment. It does not expose an argument list, owner PID override, or
private-socket parameter. The helper reads `SKY_CUA_SERVICE_NATIVE_PIPE_PATH`
at `0x10002522c`; the client recognizes the same environment key. That proves
a socket-path setting exists, not that independent simultaneous helper
instances or all shared state are isolated. Coexistence with the Codex app's
preview must remain unsupported until the original lifecycle and ownership
behavior are proven in a disposable desktop. Never replace an app-owned
host connection or spoof its owning PID.

Integration points: `lcu/runtime.py:_configure_macos_lifecycle` and the macOS
launch branch; `lcu/macos_host.py` supervisor/lifetime ownership;
`lcu/macos_sky_service.mjs` session/turn forwarding. Keep the original native
client's `turn-ended` command already wired at `macos_host.py:96`.

**Decision:** go for an isolated companion prototype using original components.
No-go for shipping preview support, multi-session concurrency, or Codex/LCU
coexistence before a desktop test. Minimal proof: two fixture sessions share
one companion; original window preview and macOS indicator appear; normal
completion, interruption and companion loss end the intended stream; one
session's cleanup does not terminate the other session.

### Preview placement and visible host requirement

The native addon owns the preview rendering panels, but it does **not** provide
a hostless floating-preview mode. `-[PIPStackController
publishItemWithPresentationID:size:contextID:animated:]` (`0x1bd54`) calls
`ensureStackWindow` (`0x1c068`), which creates `PIPStackWindow`.
`-[PIPStackWindow init]` (`0x315b4`) calls
`RemoteHostedPIPContentCreateStackPanel` (`0x31714`) twice. That function
allocates `NSPanel`; decoded original titles are `Computer Use` and
`Computer Use Controls`. These are native windows, not terminal output or
web elements embedded by MCP.

Visibility still depends on a host. `-[PIPStackWindow orderFront]`
(`0x31a34`) obtains `currentHostForAnchoring` and explicitly orders both panels
out when the host is nil (`0x31a58`–`0x31a80`). The default owner selector
`RemoteHostedPIPContentOwnerWindow` (`0x2aaa4`) checks this process's `NSApp`
key window, main window, and ordered windows. Its candidate predicate
(`0x2a9e8`) rejects nil, invisible, miniaturized, `NSPanel`, and nonzero-level
windows, and requires a content view. It does not discover an external
Terminal window to attach to.

`registerRemoteHostedPIPContentHost` (`0xdbcc`) resolves a same-process view
pointer from `nativeWindowHandle` (`window` call at `0xddcc`), or searches
`NSApp.windows` by content bounds/title (`0xdedc`). The native registration
function (`0x2bc24`) rejects a nil owner at `0x2bca4`, rejects a miniaturized
owner, and requires a content view. Registered-host lookup (`0x2b584`) also
requires the owner to be visible and not miniaturized. A geometry-only
registration with no actual owner is therefore insufficient.

The exact strings accepted by `setRemoteHostedPIPContentPlacement` are
`pet`, `home`, and `pinned`, decoded from the original CFStrings at
`0xa37f8`, `0xa37d8`, and `0xa3818`. The service implementation (`0x14df4`)
requires a running host, matching active thread, and an existing presentation.
`pinned` requires the registered `codex-main-thread` host.
`sendStackToPet` (`0x15f2c`) looks up `avatar-overlay`; when absent it records
a pending placement and invokes the shell's PetWakeRequestHandler. It does
not create the missing host window. `home` calls `returnStackToCodex`
(`0x15fb8`). These names are original desktop placement contracts, not an
arbitrary `floating`/`docked` enum.

**Consequence for harnesses:** a terminal harness would need a separate,
visible LCU companion window with the original native panels anchored to it.
A native GUI harness can supply its own window only through an explicit
same-process integration. An arbitrary GUI harness connected through MCP has
the same separate-companion requirement as a terminal. Screen position is an
LCU host-window placement decision; the original source does not establish a
universal desktop corner. Creating that visible host through the installed
Objective-C bridge is a concrete prototype route, not a demonstrated
standalone result. Import success and the native panel constructors do not
prove end-to-end display. Validate it on a disposable desktop before making
that claim. No host, helper, or preview was launched for this placement audit.

### Stop and native status without rewriting the AppleEvent worker

The original `targets/mac/client.js` exports `MacComputerUseClient`. Its
JavaScript runtime has a `request(requestType, payload, options)` method;
the TypeScript declaration marks it **private**. This is an internal original
implementation seam, not a supported public API.

The existing original method serializes payloads, retains the original API
version and timeout behavior, forwards Codex metadata, and uses the original
`MacNativePipeTransport`. That transport requires
`globalThis.nodeRepl.nativePipe.createConnection`. Merely importing the client
into the plain Node companion does not supply that trusted capability.

Place host-control calls inside the existing trusted
`lcu/macos_sky_service.mjs`, import the original internal client by an absolute
path derived from the selected installation, and leave the original agent
tool API unchanged. The companion can request bounded host controls through
an extension of LCU's private lifetime connection. Invoke the original
request method with `ComputerUseIPCAppStopRequest` and `{app: bundleId}`, or
`ComputerUseIPCCodexStatusItemMenuStateRequest` and an empty payload. Preserve
the original options, metadata and authorization path; do not implement a new
helper socket client. A separate original client instance avoids deliberately
queueing a user Stop behind the same client's pending action, but native
concurrency semantics still require the fixture test.

Original desktop references: menu action at main 4057352; worker
`stopApplication` at 1988802 and dependency at 2213355; original AppleEvent
wrapper `Ske` at 2027854. The helper's registered request catalog includes
AppStop, and the generic dispatcher resolves registered request names.

Stop is not persistent revocation of the app's always-allowed grant. The
native handler at `0x10014cab4` reaches `0x100166b58`, marks the per-app
stopped intervention reason through `0x1000a1648`, and deactivates the current
instance. Original error `userStoppedSession` (`-10012`) describes a stop for
the current turn and tells the assistant to end its work; a later assistant
turn can resume. Do not promise that pressing Stop means continuing the same
turn freely in other apps. Harness-level turn interruption and native Stop
must retain their separate original responsibilities.

**Decision:** go for the original-client control bridge after verifying the
current selected client layout. No worker-source extraction is necessary for
this route. Minimal proof: fixture app is active, native menu lists it, user
Stop returns the original stop condition to the current turn, subsequent
same-turn actions follow original rejection semantics, and a new turn follows
the original restart/approval behavior. Test native control while an action
is pending, not only while idle.

### Click-sound preference

Main `kje/Aje` at 1764221/1764399 call `/usr/bin/defaults` for domain
`com.openai.sky.CUAService`, key `computerUseSoundMode`. Original settings UI
values are `foregroundClicks`, `foregroundAndBackgroundClicks`, and `off`.
The native helper supplies the sounds; LCU needs only a user settings control.

Add a user settings command in `lcu/runtime.py` that uses this existing native
preference contract through `/usr/bin/defaults`. This is preference wiring to
the intact helper, not another sound implementation. The contract is established
by the installed official host source; it is not claimed to be a publicly
supported SDK API. Do not extract `kje/Aje` into a separate executable fragment:
the macOS policy requires the original app/runtime to remain in place, and the
Windows-specific extraction adaptation is not automatic authority for macOS.
Do not change user preferences during setup merely because a helper was selected.

**Decision:** go for a host preference control, without original code copying.
If the implementation requirement is to invoke the exact private desktop
getter/setter rather than the existing native preference contract, that stricter
variant is blocked by the same missing module export as approval management.
Minimal proof: in a disposable user session, save the prior value, set each
original mode through the preference contract, exercise fixture
foreground/background clicks, and restore the prior value. A defaults read
alone proves storage, not audible behavior.

### Always-allowed app review/removal

Main `bM/SM/xM` at 1757317/1757635/1757461 provide original list/remove/write
behavior. On macOS the original store is the helper's
`Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`.
The UI says removing a grant causes another request in the next computer-use
session. This is distinct from stopping an active turn.

All 27 original `.vite/build/*.js` modules were inspected for this registry
and store. Only the main bundle contains `getAppApprovals`, `removeAppApproval`,
and `ComputerUseAppApprovals.json`. Its `Mje` class is private; its only other
reference constructs the internal desktop service at character 3591235. The
main bundle exports `runMainAppStartup` and two feedback-archive functions,
not the settings manager. The exported renderer functions in
`computer-use-app-approvals-query-c9e4b2dae9e7.js` call the existing desktop
RPC object `computerUseSettings`; they do not implement or expose standalone
approval storage access. Importing the renderer wrapper cannot supply the
missing desktop service.

The original `@oai/sky` package exports its Sky API and trusted service;
the original native client and all 46 addon exports expose no list/remove
approval method. No original CLI subcommand for it was found. App metadata
lookup `TD` is separately exported from `src-BSSLXJxP.js`, but exporting a
dependency does not export the private approval functions.

**Decision: blocked for an independent LCU implementation under the current
strict reuse design.** The original desktop app already supplies this UI;
LCU cannot invoke the implementation independently through an observed
original export. Extracting private `bM/SM/xM` declarations into another
executable module would depart from macOS app/runtime reuse in place. The
Windows adaptation is explicitly platform-specific and does not authorize
that change. Directly recreating list/remove behavior around the discovered
JSON file would be a replacement settings implementation, not a newly found
original callable. No such implementation is proposed here.

The exact upstream seam needed is either (a) an importable original module
exporting the settings manager or list/remove methods, with its real
dependencies, or (b) original authenticated helper IPC requests for enumerating
and revoking always-allowed app grants. Once that exists, `lcu/runtime.py`
can dispatch a user settings command through the companion/trusted-service
bridge without implementing permission persistence. Minimal proof then uses
a generated fixture app: grant, list, revoke, and observe the original prompt
in a fresh session. No preference reads/writes or approval mutations were
performed in this audit.

### Browser preview controls

The native companion can also use original
`upsertBrowserUsePIPContent`, `invalidateBrowserUsePIPContent`, and
`setBrowserUsePIPContentClickHandler`. Original `roe` at main 236897 consumes
`codex/toolSurface` metadata on completed tool results and invalidates previews
on closed tabs, session end, turn completion, and thread removal. Original
`coe` at 240213 focuses Chrome through the existing extension native pipe's
`focusTab` method, matched by extension instance identifier.

Reuse original browser-result metadata; do not add browser screenshot or
focus implementations. The private source controller expects desktop
app-server notifications and is not independently exported. Under current
macOS in-place rules, do not extract that controller into a new executable
fragment. LCU may invoke the existing native presentation exports and connect
the original browser service's focus capability while preserving cleanup
semantics. This is presentation/lifetime wiring, not reuse of the private
desktop controller. Browser automation remains the already-selected original
browser service.

**Decision:** implement with the companion after the native preview test.
Minimal proof: original Chrome screenshot metadata updates the preview,
clicking it focuses the correct extension/tab, closing the tab and ending
the turn removes it, and another session's preview survives.

## Already inherited and exact exclusions

Original macOS `create_client.js` exposes 12 ordinary entries including its
target marker: app listing/state, click, drag, paste, secondary action, key
press, scroll, text selection, set-value and typing. Original optional audio
adds start/stop recording when `SKY_ENABLE_AUDIO=1`; LCU preserves caller
environment. These are not missing host implementations. Permission prompts,
accessibility operations, screenshot production, native input and controller
behavior stay in the original helper.

The original app's `requestPermissions` sends a get-skyshot request for
System Settings. It does not establish a separate passive grant-status
endpoint. Current onboarding evidence limits remain unchanged.

Current LCU turn-end cleanup is implemented, including failure reporting and
retry behavior. It is not a new gap merely because PiP is absent. No separate
host callback for a global emergency stop or ordinary physical-input takeover
was identified among the enumerated exports/registries. Native helper user
interruption behavior is not absent solely because it is not in the host API.
Locked-use physical-input handling belongs to the separate locked-use audit.

Windows LCU already materializes an unchanged original host factory and
forwards its native transport, approval bridge, and turn cleanup. The Windows
host shape reviewed here has transport methods `ping`, `close`, and `request`,
plus lifetime methods `closeActiveTurn`, `hasActiveTurn`, and `dispose`.
Current installed macOS main calls that factory `Qre`; this is not evidence
about minified names in the selected Windows application. This audit does not
revalidate a Windows executable or prove new Windows desktop behavior. Linux
native parity and architectures other than this macOS ARM64 installation were
not exhaustively audited. Keep existing platform verification limits.

Completeness is limited to the three complete registries, their identified
host-service/menu event registries, current LCU adapters, and the call paths
above, including the additional 27-module approval-export search. It is not a
claim that every compiled helper feature, every product
plugin, every feature-gated code path, or every supported platform has been
exhaustively tested. Remaining concrete work is companion isolation/lifetime,
trusted-service control bridging, an upstream approval-manager export, and
disposable desktop behavior tests. None justifies a replacement capture,
accessibility, input, browser, or MCP implementation.
