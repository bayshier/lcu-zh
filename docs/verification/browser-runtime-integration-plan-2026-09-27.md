# Browser, runtime, and harness integration inventory, 2026-09-27

LCU already executes the original browser and native-action APIs. The missing work in this scope is browser presentation, desktop-owned browser hosting, fuller harness context, and convenient audio opt-in. An API described in a bundled document is not proof that its required provider exists.

This is a read-only source inventory and implementation plan, not a desktop verification result. No personal desktop action, account access, credential flow, permission change, or runtime modification was performed. Native helper administration and native PiP are covered by [the host-gap inventory](computer-use-host-gaps-2026-09-27.md) and [the sharing-indicator investigation](macos-sharing-indicator-2026-09-27.md).

## Source boundary and reproducibility

The selected installed application was `/Applications/ChatGPT.app`, version `26.924.22138`, build `11645`, bundle ID `com.openai.codex`. Its ARM64 runtime manifest reports `0.0.24/20260924074400-f52ea85e2a98`, Node `24.21.0-cua.1`.

The following names are local primary-source locators, not files to copy into a release:

| Label | Original source | Identity |
| --- | --- | --- |
| `MAIN` | `Contents/Resources/app.asar`, member `.vite/build/main-C5425b_s.js` | SHA-256 `91a68c5f690e60033152a34cf0bf5c4234caeb9ddb47586fd3ef5b017bb29d64` |
| `BROWSER` | `Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs` | SHA-256 `fc0660ba45e6c10b532d8faa0c1bac704d987dad3d4b74478f49fdd82bf90086` |
| `API` | The same package's `environment-docs/codex-app/api.json` | SHA-256 `4ed76a13a94e7249fefca7e4af382f8f7cb9207bb3663df5722be96e6a918e44` |
| `UNIFIED` | `@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/` under the installed runtime modules | `create_tinysky_alt.js` SHA-256 `dbe5670314df83184341e58ce0a8e1555537930613cde772905ce18c31744200` |
| `SKY` | `@oai/sky/dist/project/cua/sky_js/src/` under the installed runtime modules | Files identified below by original method/module name |

Byte offsets below refer to UTF-8 bytes in these exact files. Most shipped JavaScript files are minified on line 1. Extracted main source used for read-only analysis lives outside Git at `/private/tmp/lcu-sharing-host-investigation/main-C5425b_s.js`. No original implementation or generated extraction fragment is included here.

The inventory covers the current unified public API, all 22 interface groups and 147 members in the browser API registry, the eight capability documents in the `codex-app` environment, their relevant current service gates, and the original desktop consumers examined below. It is not an assertion that every private symbol in the application has been audited or that every advertised method works on every provider.

## Complete interface-group checklist

Each row is a feature group, not a claim of live verification. The original backend's reported overrides and capability list remain authoritative.

| Original interface group | Covered behavior | Current LCU disposition |
| --- | --- | --- |
| `Agent`, `Documentation` | Browser discovery entrypoint and packaged documentation | Original implementation loaded by the unified launcher |
| `Browsers` | List/select, default browser, URL-based selection | Original implementation; LCU's default backend admission selects external Chrome |
| `Browser` | Tabs, user-owned tabs, history, session naming, capability discovery | Original implementation; history and user-tab availability remain backend/policy dependent |
| `BrowserUser` | Open user tabs, claim a tab, bounded tab context | Original implementation; `getTabContext` is unsupported by default for all three registry backend types |
| `Tabs` | List, get, new, selected tab, background URL content | Original implementation; `Tabs.content` is unsupported by default for all three backend types |
| `Tab` | Navigation, screenshots, close, JavaScript dialogs, deliverable/handoff marks, optional manual handoff | Original implementation; cloud manual handoff is unsupported by default for all three registry backend types |
| `AXAPI` | State/screenshot, click, drag, paste, key entry, scroll, text selection, set value, secondary action | Enabled by LCU's original Tinysky configuration; retains original checks |
| `ContentAPI` | General export, Google Workspace export, YouTube transcript export | Original implementation; general `export` is unsupported by default for all registry backend types; specialized exports still require actual backend/site support |
| `CUAAPI`, `DomCUAAPI` | Coordinate/DOM interaction and media-download helpers | Original alternate surfaces; Tinysky enables `Tab.ax` and disables `Tab.cua`/`Tab.dom_cua` overrides. This is the original unified selection, not an omitted LCU engine |
| `PlaywrightAPI` | DOM snapshot, locators, read-only evaluation, navigation waits, downloads, file choosers | Original implementation; undocumented element-inspection helpers in the registry are not an invitation to change original guidance |
| `PlaywrightFrameLocator` | Frame-scoped locator construction | Original implementation |
| `PlaywrightLocator` | Query/filter/combine, read, click, fill, check, select, press, wait, media download, constrained evaluation | Original implementation |
| `PlaywrightDownload` | Completed download path | Original implementation |
| `PlaywrightFileChooser` | Multiple-file status and file selection | Original implementation and approval/path checks |
| `TabClipboardAPI` | Session clipboard read/write | Original implementation |
| `TabDevAPI` | Browser console logs | Original implementation |
| `AlertDialog`, `BeforeUnloadDialog`, `ConfirmDialog`, `PromptDialog` | Inspect and accept/dismiss supported dialogs | Original implementation |

The eight optional capability families are also retained:

| Capability | Original operations | Gate and conclusion |
| --- | --- | --- |
| `visibility` | `get`, `set` | Requires backend support; already used by `cua.createBrowserTab(..., {visible})` |
| `viewport` | `set`, `reset` | Requires backend support; existing API, no LCU host replacement needed |
| `management` | Windows, tabs, groups, bookmarks, `getAuditTrail` | Existing original restricted browser-organization API; use only methods the backend admits |
| `pageAssets` | `list`, `bundle` | Existing original API and download/origin policy |
| `cdp` | `send`, `readEvents` | Original preference and enterprise gates; not a missing transport flag |
| `webmcp` | `fetchTools` and returned document-bound tools | Original backend capability and configuration/model checks; no additional MCP engine belongs in LCU |
| `browserAuth` | `request` | Broker-dependent secure authentication; not established as locally usable standalone |
| `botDetection` | `report` | Cloud-task reporting capability; availability is provider-owned, not enabled by shipping its documentation |

Evidence: `API`; capability documents under `environment-docs/codex-app/capabilities/`; `BROWSER` byte 1683004 vicinity implements `isFullCdpEnabled`/`isWebMcpEnabled`, byte 1685413 implements the full-CDP configuration/enterprise decision, and `Wee` at byte 1761305 enriches/removes capabilities according to those decisions. WebMCP also has a real model restriction in `Vs` at byte 1237305; do not spoof model identity to change admission. The Tinysky switch is `zee` at byte 1762140. Optional capability discovery is not proof of execution.

`UNIFIED/create_tinysky_alt.js` retains the original `computer` object and installs browser/app convenience methods. `UNIFIED/create_browser_api.js` handles exact URL references, tab IDs, complete tab mentions, profile selection, optional user-tab claiming, session names, visibility, and the initial observation. `UNIFIED/bind_tab.js` augments the original tab object rather than substituting a reduced browser implementation. `SKY/sky.js` mirrors all methods advertised by the original trusted Sky service; `SKY/service.js` dispatches them unchanged. Therefore adding parallel LCU implementations of these methods would not close a demonstrated gap.

## Missing integration plans

### 1. Browser previews and click-to-focus

**Status:** missing desktop presentation consumer. The original browser service already produces the needed state. A native preview implementation can reuse the installed original native addon, but standalone host initialization and its event loop remain prerequisites, as documented in the PiP investigation. This is separate from a continuous native-app capture stream.

`MAIN` function `roe`, byte 236897, consumes `item/completed` MCP results whose `_meta["codex/toolSurface"]` describes browser activity. Its fields include browser ID/family, extension instance, current tab IDs, a screenshot's tab ID/data URL, and session-ended state. It calls original `upsertBrowserUsePIPContent` through `$ae` at byte 235572, `invalidateBrowserUsePIPContent` through `eoe`, and installs `setBrowserUsePIPContentClickHandler` through `Qae` at byte 233712. The source removes stale frames and clears thread presentations on completion, archive, close, and deletion. No new screenshot should be taken solely to implement this preview.

Implementation plan:

1. Establish the original macOS native presentation host under the conditions and tests in the PiP plan. Load `Contents/Resources/native/sky.node` in place using the selected signed runtime. Do not copy or patch the addon or the app.
2. Add an optional presentation-result callback to `adapters/client.mjs` and the Codex/Claude relays, with a host control channel managed by `lcu/runtime.py` and `lcu/macos_host.py` or a separately named native-presentation lifetime module. Forward the real session/turn and original result metadata; do not reconstruct tab state from model prose.
3. Feed metadata screenshot bytes to the original addon’s `upsertBrowserUsePIPContent`, use the installed original browser icon resource, and invalidate the same presentation when original metadata closes its tab or ends its session. Connect harness turn/session closure to presentation cleanup. Keep browser cleanup and native presentation cleanup distinct.
4. For a terminal harness without a native preview host, a read-only preview/status display is presentation work. In Pi it can be implemented with `renderResult` using retained `details.originalResult`; it must not claim to be the original macOS PiP.
5. Clicking a preview must focus the matching original tab. `MAIN` function `coe`, byte 240213, discovers the original extension by its exact instance ID and sends its original `focusTab` request with session and numeric tab ID. This is a concrete original RPC seam: a small standalone host adapter can connect to the original extension host, query `getInfo`, match `metadata.extensionInstanceId`, and forward `focusTab` with `session_id` and `tabId`. `MAIN` function `cl`, byte 240915, documents request-ID correlation, native-endian four-byte framing, an 8 MiB response bound, and a one-second deadline. Prefer reusing an exported original native-pipe client if found; otherwise this bounded transport adapter is host wiring, not a new tab-input implementation. The original extension performs focus and enforces its session behavior. Use the user click as the trigger, reject invalid/stale IDs, and never select the first available profile as a fallback. The IAB registry's `focusBrowserUseTab` at byte 2513806 additionally requires the desktop route described below. Existing original `management`/visibility APIs can also serve user-requested focus actions when admitted; that does not prove the native preview-click path.

**Smallest proving test:** in a disposable macOS guest with an isolated Chrome profile, create two fixture tabs through original CUA, observe their metadata frames in the original native host, update one fixture and confirm the matching frame changes, close one tab and confirm only its frame disappears, and finish/interrupt the turn. If click focus is included, click each preview and independently verify the correct original profile/tab becomes active. Test rejected/absent host connections and host restart. Until then, native preview is a source-backed integration candidate, not a supported feature.

### 2. Embedded in-app browser

**Status:** a real omitted original provider, but **no-go for a promised standalone implementation with the currently established seams**. `BROWSER_USE_AVAILABLE_BACKENDS=iab` does not create it.

Current evidence is stronger than the retired copied-host experiment:

- `MAIN` byte 2466178 returns the original `Codex In-app Browser` provider with `type: iab` and capabilities; byte 2472914 binds its metadata to the real conversation ID.
- `MAIN` `requireBrowserUseSession` near byte 2471463 requires a route; `getRequiredBrowserHost` at byte 2476577 requires the original browser host. Creating a tab calls that host's `openPageForBrowserUse`, obtains an Electron `webContents`, and retains navigation/debugger/capture/tab-lifetime integration.
- The original registry's `ensureBackendForSession`, byte 2527023, constructs private `YYe` and starts private `gXe`, with route validation, navigation-block listeners, and the original browser session delegate. It runs only when its native-pipe feature is enabled.
- `BROWSER` `Mee`/`Nee` near byte 1759184 only discover existing providers and filter by exact session ID and, when supplied, build flavor.
- `@oai/browser-desktop/package.json` exports only its original client and service. `MAIN` exports the app startup and two other aliases; the inspected provider constructor/server are not exports. Loading and rewriting private source to export them would recreate the retired extraction architecture.
- Current [runtime.py](../../lcu/runtime.py) admits `chrome` by default; [setup.py](../../lcu/setup.py) explicitly rejects embedded-host setup.

Two possible supported directions must be distinguished:

1. **Attach to an existing original desktop-owned browser session:** use that task's actual identity and original app-created route, preserve its build flavor, admit `iab`, and let the original service discover it. This requires an explicit desktop host connection/session handoff. Do not invent another task's identity or claim arbitrary LCU sessions are already routable. The currently inspected LCU code has no API that asks the intact app to establish that route for an external harness.
2. **Standalone original IAB host:** requires an upstream callable export, supported original host entrypoint, or existing original app-service transport that provisions a route and host. The exact blocker is not browser JavaScript or CDP: it is obtaining the private Electron provider/session registry without copying, patching, or extracting a replacement host. `lcu/app_server.py`'s generic RPC adapter does not itself supply the Electron browser host.

Once a sanctioned seam is established, place route/lifetime management in a dedicated host module selected by `lcu/runtime.py`; let `lcu/browser.py` and `lcu/setup.py` expose explicit attachment/setup, and keep the original browser service authoritative. Do not reinstate `--with-browser-host` merely to bypass the blocker.

**Smallest proving test:** intact selected signed app, disposable guest/profile, real original desktop session route, independent harness with the correct session metadata; create a tab, navigate a loopback fixture, perform one action, verify screenshot and independent page state, exercise visibility/viewport, retain a deliverable and handoff tab, clean up an unmarked tab, and reject a foreign session. Verify the app's files/signature are unchanged. Historical extracted-host passes do not satisfy this gate.

### 3. Audio opt-in and actual audio delivery

**Status:** `--audio` setup/runtime opt-in and live original audio capture in a disposable desktop guest are verified. The tested maintained host result contracts pass a saved WAV file reference to the provider, not WAV bytes; model-native audio input is not supported by those contracts. These are computer audio samples, not the native UI's notification sounds. See [the audio opt-in verification record](audio-opt-in-2026-09-27.md).

`SKY/targets/mac/create_client.js` and the Linux/Windows constructors install audio methods only for `SKY_ENABLE_AUDIO=1`. Mac `audio_recording.js` asks the original audio approval, starts/stops the signed helper, validates a local WAV result, and returns its bytes/data URL. `MAIN` byte 174003 admits both `SKY_ENABLE_AUDIO` and `NODE_REPL_ENABLE_AUDIO` only when both caller flags are set. The unified object retains the original computer object, so `cua.computer` receives the same optional methods. LCU preserves caller environment but does not offer an audio setup flag; an agent launcher's environment filtering can prevent a caller flag from reaching the MCP child.

Implementation and remaining verification:

1. `lcu --audio` sets both original flags on the original MCP child. `lcu setup --audio` persists that runtime option in each maintained client registration, and portable exports retain it. Without either explicit `--audio` or the caller setting both original environment flags, the default child environment has neither flag. Existing caller values survive when no CLI opt-in is selected. The enabled original runtime has no audio-use guide in the inspected unified static instruction files. The desktop's separate audio skill admission in `MAIN` is not proof that unified guidance automatically changes; LCU does not invent replacement instructions.
2. Keep `SKY` approval/capture/duration/output code unchanged. Do not substitute microphone recording for computer audio.
3. Keep the existing exact-byte file fallback for hosts whose tool-result model cannot accept audio. [audio-files.mjs](../../adapters/audio-files.mjs) implements the Codex/Pi fallback. Claude forwards the original result; the recorded host fixture saved it and exposed a file reference. A local file is not a model audio input.
4. Add native-audio pass-through only behind a positively established host/provider capability and a test that captures the actual provider request. Do not infer audio support from MCP's AudioContent type, a model's product name, or a saved WAV.

Current concrete blocker: Pi 0.87.1's installed `pi-agent-core/dist/types.d.ts:366` and `pi-ai/dist/types.d.ts:376` restrict tool results to text/image content. Its coding-agent extension type has the same restriction at `dist/core/extensions/types.d.ts:795`. Those inspected packages are under `/private/tmp/lcu-pi-cli-0.87.1/node_modules/@earendil-works/pi-coding-agent/`. A new `audio` block cannot be added in LCU without a host API change. The tested Codex and Claude delivery results are recorded in [the harness matrix](harness-results-2026-09-26.md), [current Codex CLI verification](codex-standalone-cli-2026-09-27.md), and [current Pi/Claude verification](latest-standalone-harness-2026-09-27.md). They do not establish native model audio support.

**Smallest proving test:** isolated guest plays a generated tone, original paired flags off/on change audio-method exposure, original approval remains required, original capture returns a WAV whose duration/spectral content match the fixture, and every supported harness retains exact bytes. Separately, a synthetic MCP audio result must reach a local scripted provider as audio bytes in its supported input shape before claiming model audio delivery. No transcription workaround should be mislabeled original audio parity.

### 4. Tab/app context pickers and metadata presentation

**Status:** the Pi adapter implements a user-invoked app/browser/profile/tab
picker. Adapter regressions cover stale identities and the live Pi 0.87.1
browser TUI check selected an existing Chrome user tab and inserted guidance
without submitting the draft or claiming the tab. macOS picker behavior and a
live stale-target race remain unverified; other harnesses do not reproduce the
desktop picker and activity UI.

The current unified API already parses complete tab mentions, selects the referenced browser profile, validates snapshot title/URL, and rejects stale or ambiguous references. It also accepts an exact URL within an explicitly selected browser. Original Chrome `openTabs`/`claimTab` and session-owned tab methods are intact. `MAIN`'s tab-mention service additionally supplies UI search, liveness, focus and invalidation subscription; its `focusChromeTab` is at byte 1538000. Those shell affordances do not need new automation methods.

Implementation plan:

1. Keep the Pi picker on the original browser inventory/selection interfaces and pass the selected original reference or exact browser/tab identity to the current unified API. Keep the original stale-reference check. Do not scrape Chrome profile databases or invent a second browser-discovery implementation. Extend comparable pickers only where a harness exposes a supported interactive API.
2. Preserve original `_meta` as the relays currently do. Render `codex/toolSurface` activity and preview metadata in the host UI using the original app/tab IDs. Pi's `details.originalResult` already retains this data; use `renderResult`/status APIs without adding model-facing tool schemas.
3. A byte-for-byte replica of the desktop's mention URL construction and invalidation behavior needs its original callable mention service. `MAIN`'s private UI service is not a demonstrated standalone export. An exact-ID picker can be shipped independently; do not call it identical desktop mentions.
4. Use `adapters/client.mjs`, `adapters/pi/index.ts`, and the relay result callbacks for presentation. No change to the original `cua.getTab`/`cua.getApp` implementation is needed.

**Smallest proving test:** disposable profiles with equal tab titles/URLs, select by actual profile and tab ID, acquire only that tab, navigate it after selection and verify a stale original mention is rejected, close it and verify the picker invalidates it. Confirm user-only listing did not claim a tab and that no tab belonging to another harness session is reassigned by fabricated metadata.

### 5. Complete per-call context and generic elicitation support

**Status:** the maintained adapters already pass real session/turn IDs, but do not all carry the entire original host context or render every possible elicitation.

- Pi passes model ID but ignores its execute callback's tool-call ID; `adapters/client.mjs:120` currently has no call-ID input. Mac `SKY/targets/mac/computer-use-policy.js` reads real `call_id` or `item_id` to associate approvals with a tool call.
- Claude tracks its real tool-use ID but constructs original turn metadata with session and turn only in `adapters/claude.mjs:224`. It does not establish model metadata or the original subagent thread fields. Its current child-ID adaptation is recorded in existing lifecycle tests.
- `BROWSER` near byte 1070205 reads the real model; its session resolver uses `thread_id` when `thread_source` is `subagent`. Additional fields therefore are not merely labels. Do not fabricate them or adopt a Codex model identity for another model.
- Pi currently cancels URL-mode and nonempty form-schema elicitations in `adapters/pi/index.ts:92`. It intentionally supports original native-app persistence choices and empty-form approval prompts. Codex and Claude relay form/URL elicitations via the official MCP SDK. No current supported native-app/external-Chrome task has established a generic-form gap as a user-visible failure.
- `UNIFIED/create_documentation.js` accepts trusted host-supplied `openai/confirmation_policies.computer_use` metadata and otherwise loads its original confirmation guidance. A future generic metadata channel must preserve a real managing host's policy input rather than invent it. The existing Codex relay passes request metadata through; the shared Pi client constructs a smaller metadata object.

Implementation plan: extend the shared call options with actual call ID and optional real host thread/source/model values; map the Pi callback ID and Claude tool-use ID only to fields with the same meaning, preserve incoming values in relay modes, and keep absent context absent. Add generic form/URL rendering to Pi only for concrete original requests that need it, using the host UI and official SDK response shape. This must not collect browser secrets into model-visible text or attempt to replace the missing credential broker. The APIs and approval policy remain original.

**Smallest proving test:** two parallel child sessions plus their parent, distinct real tool IDs, approvals and WebMCP activity correlated to the correct call, correct per-child cleanup, and no change to model restrictions. For elicitation, replay an actual original nonempty schema or URL request with accept/decline/cancel/disconnect cases; assert exact fields and cancellation propagation. Synthetic support alone is not evidence that browser authentication works.

## Already wired, gated, or outside local scope

| Area | Required conclusion and next test only if changed |
| --- | --- |
| External Chrome/Edge provider | The original installer/native host and browser service are already used. LCU's `chrome` backend denotes the extension backend; original family selection supports the browser family reported by the provider. Installed-family discovery is not an action test. A new family/platform support claim needs its own isolated fixture. |
| Session names, user-tab claiming, handoff/deliverable marks | Original browser code already owns these behaviors. Current original `createBrowserTab` invokes session naming and visibility. Test create/claim/mark/cleanup combinations rather than add an LCU ownership store. |
| Browser turn cleanup | `BROWSER` byte 1770744 registers the original `addTurnEndedHandler`; maintained adapters send `turn_ended` with real IDs. This is not currently missing. Lifecycle failure/disconnect cases remain explicit test limits in the harness records. |
| macOS native turn cleanup | Current `lcu/macos_sky_service.mjs:52`, `lcu/macos_host.py`, and `runtime.py` register/relay the original turn-ended callback and invoke the original signed client. Historical pre-change absence must not be reported as current. |
| Windows helper/lifetime | Current `runtime.py` selects the original Windows host and Sky wrapper. Existing Windows candidate limits remain unchanged; this macOS source audit adds no Windows verification. |
| Secure browser authentication | `BROWSER` byte 1199159 requires `runtime.gaas.getBrowserAuthBrokerChallenge`; the adapter near byte 1904384 is created for the GAAS environment and its original broker. The exact local blocking dependency is the broker/provider and secure host UI, not just form elicitation. No reusable standalone desktop broker or credential-binding lifecycle was established. **No-go** on promising a local implementation until an original service is located and authenticated end-to-end. Do not copy user credentials or bypass unavailable broker checks. |
| Cloud/CDP browser creation and bot reporting | The service discovers an existing compatible provider; it does not provision a cloud browser. Original CDP client code and cloud documentation do not supply that external service. The historical bounded package audit is in [browser dependencies](../BROWSER-DEPENDENCIES.md); this plan does not turn it into a claim about all newer distributions. Obtain the actual original provider before planning lifecycle wiring. |
| Account/enterprise/feature policy | Original services own these decisions. LCU intentionally defaults ambient account network and analytics off and supplies a local agent-header policy. Restoring logged-in desktop feature decisions would require an explicitly connected original account/policy service, not invented flags or copied credentials. This is not a hidden CUA action feature. |
| Raw CDP/WebMCP/history/management toggles | Existing original preferences, provider declarations and policy are authoritative. A settings command could delegate to a supported original preference API if identified, but must not silently override enterprise policy. The functionality itself is not absent from LCU. |
| Host-only tools | `turn_ended` and `js_add_node_module_dir` are deliberately omitted from model discovery where documented. Exposing them to the model is not required to implement browser actions. Generic MCP clients remain responsible for the exported tool visibility/output/approval contract. |
| Native host-services pipe | Current Mac native transport also consumes `NODE_REPL_HOST_SERVICES_PIPE_PATH`. This separate desktop service is not supplied by current LCU. The complete native-host audit found only `ensureService` startup coordination, with original fallback startup already present. It carries no turn metadata or locked-use grant. |

## Go/no-go sequence

1. **Go: bounded host/harness work.** Add paired audio setup, propagate genuine per-call context, and expose original metadata through optional harness presentation. Preserve original APIs and prove each change in its exact host.
2. **Conditional go: original native browser preview.** Reuse the original addon once native-host/AppKit lifetime is proven; feed existing metadata images. External click-to-focus has an original extension-host RPC seam and needs a bounded host transport plus the live profile/session test.
3. **No-go for a current standalone support claim: IAB.** First identify a supported route/provisioning path into the intact original desktop host. A private-class extraction or backend flag is insufficient.
4. **No-go without original external services: secure broker authentication and cloud provisioning.** Inventory the actual provider and its authenticated lifetime before proposing code changes.

All live proofs must use disposable desktops and generated local fixtures. Run repository tests in the required disposable containers. Structural checks, isolated MCP initialization, source matches, and mocked callbacks do not replace those desktop integration tests.
