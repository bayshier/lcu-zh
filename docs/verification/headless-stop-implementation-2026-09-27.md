# Headless macOS Stop control implementation and verification, 2026-09-27

This document records the implementation evidence and current test result for
the private, human-triggered macOS Stop control. The VM is recovered. The current guest runs prove Stop between native calls,
recovery in a fresh turn, and the original stopped-for-this-turn response from
an MCP call that was pending when Stop was accepted. They do not show whether
native input was interrupted mid-operation.

## Original seams

The source inspection used the host installation `/Applications/ChatGPT.app`,
version `26.924.22138`, build `11645`, including its signed helper and original
Sky runtime. The selected client is
`@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.js`. Its public
runtime method `MacComputerUseClient.request(requestType, payload, options)`
forwards through `MacNativePipeTransport`; the request options carry
`codexMetadata` and `timeoutSeconds`. LCU imports this client from the selected
app by absolute path and does not copy or replace the native transport.

In the inspected app, `worker.js` validates status records with `id`, `name`,
`bundleIdentifier`, and `bundleURL`. Its Stop dependency sends the original
`ComputerUseIPCAppStopRequest` payload `{app: applicationId}` through the
helper-PID AppleEvent route. The visible worker handler awaits that request and
returns. It contains no separate MCP or agent-execution cancellation, and its
service-control cancellation handler is empty. The native
`service-state-changed` consumer updates status-item and menu state.

The inspected `main-C5425b_s.js` (SHA-256
`91a68c5f690e60033152a34cf0bf5c4234caeb9ddb47586fd3ef5b017bb29d64`)
contains `onNativeStatusItemMenuAction` at byte `4057352`. The bundled
`worker.js` (SHA-256
`26a596c419c9b67eb10a8a498b483c2722995885ce657eb63b3b7cda896ec8e6`)
contains the worker Stop route at byte `1988802`, its dependency at byte
`2213355`, and the `Ske` AppleEvent wrapper at byte `2027848`.

### Original status-item Stop dispatch

The host app is version `26.924.22138` (build `11645`); these offsets and
hashes describe that host app, not the guest's older `26.917.62051` build.
In the host main bundle, the Stop menu callback at byte `4057401` dispatches
`stopApplication` with only the selected application ID. It does not await a
status-item snapshot or policy lookup before dispatch. The worker routes that
method to its Stop dependency at byte `1988849`. The dependency wrapper at byte
`2212820` first asks the main process for the current helper service PID, then
calls the original `Ske` wrapper at byte `2027848`. `Ske` sends
`ComputerUseIPCAppStopRequest` with `{app: applicationId}` to that helper PID.
The status-item state is a separate
`ComputerUseIPCCodexStatusItemMenuStateRequest` (`xke`, byte `2027671`); Stop
does not call it first. The wrapper retries only the AppleEvent `-600` failure
after invalidating and reacquiring the service PID.

The request uses the original AppleEvent bridge, not the Mac JS native-pipe
client: its request payload contains the app ID, request type, API version, and
target service PID, with no Codex session/turn metadata. The bridge's default
timeout is 15 seconds (`l7 = 15`, byte `2026243`); its AppleEvent send uses that
timeout. This confirms that the UI Stop is an app-level helper request. It
does not establish how the native helper orders Stop relative to a separate
pending MCP action. The guest's older build still requires guest-specific
evidence for that behavior.

The helper binary analysis describes AppStop as setting a stopped intervention
for the app's active instance and deactivating it. That analysis is from the
host app build, not the guest helper, so it does not prove whether native Stop
state is app-global, instance-scoped, session-scoped, or turn-scoped. The
visible AppStop payload contains an app identifier string, not session or turn
IDs. The original worker route carries a helper service-process identifier.

The original macOS policy resolver maps a supplied name, path, or bundle ID to
an original policy result and uses its `appPath` for the native action. LCU
uses that same `MacComputerUseClient.getAppPolicy` resolver for captured
selectors, keeps the resolved bundle ID for eligibility and public selection,
and sends the matched status entry's `id` as the AppStop `{app}` value. In the
guest, TextEdit had `id` `/System/Applications/TextEdit.app`, bundle ID
`com.apple.TextEdit`, and a `file://` `bundleURL`. A differential with the
bundle ID was accepted but did not stop the next action. The matched status
`id` produced the original stopped-for-this-turn response, confirmed in the
current archive run below.

## LCU control path

On macOS, the Pi bridge creates a mode-`0700` temporary directory and passes
its private `LCU_MAC_CONTROL_SOCKET` to the LCU child. The host creates a
mode-`0600` Unix socket. The trusted Sky wrapper connects using the original
`nodeRepl.nativePipe.createConnection` capability. Human status and Stop
requests can reach the trusted service while a Sky RPC is pending or between
computer-use calls.

The host validates the exact Pi session and active turn observed inside the
trusted runtime. Stop additionally requires an app observed in an original Sky
call for that turn. Status uses the original
`ComputerUseIPCCodexStatusItemMenuStateRequest` with captured metadata and
returns original entries filtered to that turn's observed apps. Stop refreshes
status, resolves the requested selector through the original policy resolver,
checks the selected bundle ID and active turn, then sends the matched status
`id` through the original `ComputerUseIPCAppStopRequest`. LCU reports the
bundle ID to the caller; it does not add a model-facing tool or change the
original CUA schema.

The original `type_text` action uses the module-cached client from
`targets/mac/lazy-client.js`; `client.js` keeps transports by API version, and
each `MacNativePipeTransport` instance serializes requests on its own promise
queue. The LCU control path creates a separate original `MacComputerUseClient`
instance, so its AppStop request does not wait in the original JavaScript
client's queue behind a pending `type_text`. Both clients connect to the same
selected CUAService native socket and send the original `request` JSON-RPC
envelope. The installed JavaScript source does not establish how the native
service schedules requests arriving on separate connections, so this does not
prove or disprove in-flight cancellation. The UI worker uses a separate
helper-PID AppleEvent route for AppStop; the main app's `service-state-changed`
consumer updates status-item and menu state.

Transport source hashes: `lazy-client.js`
`e222ec4e31b96c06c79819ea23a4d69a7f564c9a11f640c9d4b48c11bc75365b`,
`client.js`
`b5addc3c85ff0124095042832bca0fe1a271d119925459df7bd284dcab1931ab`, and
`native-pipe.js`
`2f1bcc0b4cd013ef3d267f6d93bd2aa29770712687c8db087d55ec9d173380e8`.

The inspected original UI worker sends AppStop without turn metadata. LCU's
native-pipe request envelope includes `codexTurnMetadata`; installed JS only
forwards it and does not establish how the helper uses it for session or
instance selection. The original helper has a distinct
`ComputerUseIPCCodexTurnEndedRequest` with Codable fields `threadID: String`
and `turnID: String?`. LCU sends this original request from its existing
turn-ended lifecycle hook with `threadID=session_id`, `turnID=turn_id`, and
the immutable `x-codex-turn-metadata` snapshot captured from normal Sky RPCs.
It then sends the existing CLI `turn-ended` notification. A failed native
acknowledgment remains pending and blocks the next Sky action while LCU retries
cleanup; a full 128-turn metadata ledger refuses new RPC dispatch rather than
evicting cleanup identity. The original bundled Node REPL accepts any positive
safe-integer hook timeout, but the host's `turn_ended` tool waits only 5
seconds for the worker's handlers and then returns "turn-ended handlers timed
out". A 22-second hook budget was therefore not honored (amontlabs/lcu#14); the
LCU hook now returns after 4 seconds and slower cleanup continues in the
background, still blocking the next Sky action until it completes.

Timeouts are bounded: native status, Stop, and turn-ended requests use 15
seconds; the trusted-service control deadline is 40 seconds; the adapter
client wait is 45 seconds; and the lifecycle hook returns within 4 seconds,
under the host's 5-second wait, while native plus CLI cleanup may run longer
in the background. The host forwards only its remaining deadline to the
trusted service. If the optional control socket cannot bind, turn metadata is
still captured and original turn-ended cleanup remains available.

## Verification

The current guest is a task-owned Apple Silicon UTM VM running macOS `26.6.2`
on `VirtualMac2,1` arm64. Its installed signed app is
`/Applications/ChatGPT.app`, bundle `com.openai.codex`, version
`26.917.62051`, build `10789`, team `2DC432GLL2`; the observed CUA runtime is
`0.0.16` (`20260915001755-492f19756c31`). Installation reuses that app and
helper in place. The source-current Darwin ARM64 archive used by the final
Stop run was `lcu-0.4.1-darwin-arm64.tar.gz`, SHA-256
`10021a5f83f26c70a99493d412aad6312b630e9b0626558164c3c30e58e12b6e`. The
release-prepared 0.4.2 Darwin ARM64 archive is
`dist/release-0.4.2/lcu-0.4.2-darwin-arm64.tar.gz`, SHA-256
`9d3a96b579c6d0c9b0fa6578ec533fb7a08391d5fd3932e5c2cb1ce26e5f1d92`; its
product source is byte-audited against the current tree. The Stop V2 guest
result below is from the 0.4.1 archive.

The final guest run used runner SHA-256
`b84be3c9572f861bc3e9352558d789cfb7c4ffba9084eb5f9342e7fd6c3d07d1` and is
preserved at
`/private/tmp/lcu-macos-audio-acceptance-20260927/native-stop-v2-between-and-recovery-20260928.json`
(SHA-256 `78f9adcba1a8e34170e1fc618c2a80ba011dedc7c99c350535e9fa5e9d1dce33`).
Original runtime warmup, desktop state, TextEdit
state, app status, and lifecycle cleanup passed. Stop was accepted between
completed native calls; the next action in that same turn returned the
original stopped-for-this-turn error. The runner checks the surfaced MCP
error text because no numeric code is present in the returned message.

The original turn-ended hook then completed and a distinct fresh turn
recovered. Its metadata had the expected session, a different turn ID, and a
call ID matching the JSON-RPC request. The new turn completed a TextEdit save;
an independent disk oracle matched all 39 UTF-8 bytes. The run recorded zero
approval prompts and zero model/provider requests.

Two final 0.4.2 guest runs used the same Darwin ARM64 archive
`9d3a96b579c6d0c9b0fa6578ec533fb7a08391d5fd3932e5c2cb1ce26e5f1d92` and
runner SHA-256
`b735ed78644849ac5d23a5a926da3629d9936c636dc8b281c3c1bd25f427a20a`. Both
exited successfully in about 10.7 seconds. Jobs
`eee37d44-0740-4a58-a9d9-9962c616a0d7` and
`2cbfa397-ce5e-4fb8-8c9b-8374917e8af3` accepted AppStop in about 5 ms while
the MCP worker thread was alive. The pending `type_text` call then returned the
original stopped-for-this-turn error; a subsequent action in the same turn was
rejected, and a fresh turn completed the 39-byte TextEdit save oracle with the
existing approval. The repeat's guest output is at
`/private/tmp/lcu-native-mac-acceptance-20260928/stop-pending.output.log` (the
first-run output was overwritten). These results prove the pending MCP call
returned the original stopped response and the next-turn recovery path worked.
They do not prove AppStop interrupted native typing atomically or at a specific
keystroke boundary: the test observed the MCP worker thread, not the native
input operation's exact state.

Earlier, one pending-action run timed out in the control route after about
30.77 seconds before an acknowledgment. A diagnostic-only run later returned
status and AppStop acknowledgments quickly, but a harness assertion rejected
the diagnostic-only extra `control_trace` field before collecting the pending
call outcome. That diagnostic failure was a test comparison mismatch; it was
not an additional product failure. The two final normal-wrapper passes resolve
the reported control timeout for those runs, but do not establish its earlier
cause or rule out timing-sensitive failure. The isolated between-call and
fresh-turn result remains separately verified.

Read-only runtime probes (`getState()` and TextEdit `get_app_state()`) passed
through the original runtime, LCU without the optional control socket, and LCU
with it. They returned without timeout or error in about 0.7–0.9 seconds and
recorded no approval events. These probes do not cover `type_text` or Stop.

The guest recovery history, including the earlier Recovery environment and
login setup, is in [macOS test guest recovery](macos-test-guest-recovery-2026-09-27.md).
The guest results do not show whether Stop interrupts an individual native
input action at a particular keystroke boundary, or prove isolation between
concurrent sessions targeting the same app. They make no new platform-support
claim.

## Linux regression gates

The 0.4.2 source passed the 197-test offline installation gate in disposable
ARM64 and AMD64 containers using the existing pinned package fixtures. Exact
commands and package hashes are in
`.verification/release-0.4.2-gates-20260928.txt`. The generated archives and
sidecars are in `.verification/arm64.DExN9x/` and
`.verification/amd64.dyem7W/`; their release copies are under
`dist/release-0.4.2/`.

The test-runner import-path fix adds both `/src/scripts` and `/src` to
`sys.path`, so the optional pinned-package preparation code can import its
repository modules in the disposable container. The full-gate run manifests
are stored beside those archives; these container checks do not establish
desktop behavior.
