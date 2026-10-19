# Original request context forwarding, 2026-09-27

This change forwards actual harness request identities through the adapter into
the installed original computer-use runtime. It does not change original tool
schemas, instructions, approval policy, sandbox settings, or lifecycle events.

## Installed-source contract

The selected local source is the installed macOS ARM64 ChatGPT app documented
in [the browser/runtime inventory](browser-runtime-integration-plan-2026-09-27.md):
ChatGPT `26.924.22138`, build `11645`, CUA runtime
`0.0.24/20260924074400-f52ea85e2a98`. The source files remain in the installed
application and are not copied into LCU.

| Original consumer | Metadata contract | Source evidence |
| --- | --- | --- |
| Sky app approval policy | Reads `call_id`, then `item_id`, from `x-codex-turn-metadata` and places the value in the original elicitation's `tool_call_id`. | `@oai/sky/dist/project/cua/sky_js/src/targets/mac/computer-use-policy.js`, SHA-256 `8cd1272d7aa836479be6c3f4cc5b0b80526339eedd4852cbb6558f893f6721f8`; function `m`. |
| Sky tool telemetry | Reads `thread_id` (fallback `session_id`), `turn_id`, `item_id` (fallback `call_id`), `model`, and `reasoning_effort` (fallback `model_reasoning_effort`) from `x-codex-turn-metadata`. | `@oai/sky/dist/project/cua/sky_js/src/targets/mac/computer-use-telemetry.js`, SHA-256 `3645bebe7ff8badca86e57367e7961e1b4ac1fb0e743c65b3e1d3e308847208e`; function `v`. |
| Original browser runtime | Requires string `session_id` and `turn_id`. Resolves a child session from `thread_id` only when `thread_source` is exactly `subagent`; reads `model` as supplied. Browser turn metadata also distinguishes `chatgpt_conversation_id`. | `@oai/browser-desktop/scripts/browser-service.mjs`, SHA-256 `fc0660ba45e6c10b532d8faa0c1bac704d987dad3d4b74478f49fdd82bf90086`; functions `je`, `vt`, `x9`, and `mc`. |
| Pi command dispatch and picker UI | `AgentSession.prompt()` runs a registered `/` extension command inline before the normal steer/follow-up queue path, including during streaming (lines 1207–1224 and 1336–1348). `ExtensionCommandContext.ui.select()`, `getEditorText()`, and `setEditorText()` support explicit selection and draft insertion. Interactive mode submits text to the active session and constructs/focuses the selector directly (lines 2615–2623 and 2032–2057). | Installed Pi `0.87.1`, `dist/core/agent-session.js`, SHA-256 `5ebfae51db5a900596145159428e7cb57d195af9d54a28f41d4ac8ff1bfd5729`; `dist/modes/interactive/interactive-mode.js`, SHA-256 `7dc366e8609d7d1e81fb85952e466aea9933b13e74842c2a9b9df678d267d12e`; extension API types `dist/core/extensions/types.d.ts`, SHA-256 `14d00e645b453f4361440da6fcda86ed6cef9a8fc36d483a621a0250e0d4a396`. |
| Original target picker APIs | The original API exposes native app IDs, browser/profile IDs, session `TabInfo.id` and `providerTabId`; the original `cua.getTab(id, {browser})` resolver accepts either exact tab ID within the explicitly selected browser. User-tab claims require a current `openTabs()` object and stale title/URL checks. | Installed browser API catalog SHA-256 `4ed76a13a94e7249fefca7e4af382f8f7cb9207bb3663df5722be96e6a918e44`; original `create_browser_api.js` and the installed `tab-claiming-chrome.md` under the paths in the [browser/runtime inventory](browser-runtime-integration-plan-2026-09-27.md#source-boundary-and-reproducibility). |

`call_id` is the right original field for the harness's actual per-tool-call ID:
it feeds the original app approval's `tool_call_id`. `item_id` has the separate
meaning used by Codex telemetry, so LCU leaves it alone unless a host actually
provides a real item ID. Likewise, LCU does not derive `thread_id` from a
session ID, set `thread_source` to `subagent` without that exact host value, or
invent model or conversation IDs.

## Adapter behavior

- Pi now forwards the extension callback's actual `_id` as `call_id`, its
  current `sessionManager.getSessionId()` as `session_id`, its active LCU turn
  ID as `turn_id`, and `ctx.model.id` as `model`. Pi does not expose the other
  original host fields through this callback, so they stay absent.
- Claude maps its exact bound `tool_use_id` to `call_id`. The relay retains
  caller `_meta`, including any existing confirmation, sandbox, approval, and
  original turn metadata; it merges the exact bound Claude session and prompt
  IDs into the original turn metadata. Existing host-supplied fields in that
  object survive. Claude's `agent_id` continues to scope child cleanup using
  the existing adapter mapping; LCU does not relabel it as `thread_id`.
- The Codex relay continues forwarding incoming `_meta` unchanged.
- `createCuaClient.call` accepts optional exact host fields and caller metadata,
  preserves unrelated metadata, and overlays required real session/turn IDs
  and any supplied call/model/thread values in `x-codex-turn-metadata`.
- Pi's `/lcu pick` is idle-only. It obtains native app and browser/profile IDs
  from separate original inventory calls so one unavailable source does not
  hide the other. It lists session tabs or open user tabs from the chosen
  original browser and re-reads the chosen identity before inserting guidance
  into the existing editor draft. It uses `TabInfo.id` plus provider-ID/title/
  URL snapshots for a session tab. It never claims a user tab itself and never
  submits the draft. The inserted guidance asks the next request to revalidate
  the target; it does not enforce future model behavior. The command uses the
  actual Pi session and model, an adapter-owned cleanup turn ID, and no
  fabricated tool-call ID. A session switch, new active turn, cancelled menu,
  stale target, or failed cleanup leaves the editor unchanged.
- On macOS, the shared client creates a private per-client Unix-socket path
  before launching its MCP child and passes it as `LCU_MAC_CONTROL_SOCKET`.
  The host adapter methods use bounded newline-delimited JSON requests for
  original `status` and `stop` control. Pi exposes only `/lcu stop`: it gets
  the original active-app list for its exact live session/turn, lets the user
  select an app by its original bundle identifier, then sends that identity to
  the host. The backend separately verifies these IDs against trusted original
  request metadata before it can call the installed original Stop method.

## Focused regressions

`adapters/test/client.test.mjs` asserts the resulting original MCP request
contains the exact supplied call/thread/model values and retains caller
confirmation and sandbox metadata. Its host-control fixture asserts exact
socket messages and fail-closed error handling. `adapters/test/pi.test.mjs`
checks that two distinct Pi callback IDs reach two actual original calls and
that `/lcu stop` uses the private socket while a tool call is pending. Picker
tests execute each emitted JavaScript request against a small fake original CUA
surface, distinguish duplicate profiles and same-title tabs by original IDs,
and cover stale selection, cancellation, and a real Pi turn beginning during a
picker menu. The last case proves cleanup ends only the picker command turn and
leaves the real active turn's tool calls usable.
`adapters/test/claude.test.mjs`
checks the exact tool-use ID, distinct overlapping parent/child calls,
retention of caller metadata, and preservation of the established per-child
cleanup identity.

The three focused suites passed 23/23 in the disposable, network-isolated
`lcu-verification:arm64` container using `node --test
test/client.test.mjs test/claude.test.mjs test/pi.test.mjs`. JavaScript syntax
checks passed for JavaScript source and focused test modules. A subsequent
interactive Pi smoke test exercised the installed Pi `0.87.1` command
dispatcher, terminal selection menu, and editor API; the native picker evidence
is recorded below. The socket protocol and Pi in-flight command path remain
fixture-tested. A recovered macOS guest then exercised the private control
bridge against the original app: status returned the original active app,
AppStop was accepted, and the next same-turn action returned the original
stopped-for-this-turn error. The guest run did not drive the actual Pi
`/lcu stop` menu end to end. The final guest runs proved recovery through the original turn-ended hook and
that a pending `type_text` MCP call returned the original stopped-for-this-turn
error after Stop. They do not prove that native typing was interrupted at a
specific keystroke boundary. See
the [Stop implementation record](headless-stop-implementation-2026-09-27.md).
The live browser-tab picker TUI check below supersedes the earlier statement
that browser/profile/tab selection had not been tested. It verifies the happy
path only; stale-profile rejection remains covered by adapter regressions, not
by a live race in the TUI.

## Live browser-tab picker TUI

On 2026-09-28, a network-disabled disposable Linux ARM64 fixture ran the real
Pi 0.87.1 terminal UI with the final LCU 0.4.2 ARM64 runtime and the original
Chrome extension provider. The `/lcu pick` menu selected the existing Chrome
profile and an open `about:blank` user tab by the provider's original tab ID.
Pi's real editor API readback confirmed the inserted guidance preserved the
chosen profile and tab identity. The test did not submit the draft, claim the
open tab, launch a browser, or make a provider request. A fixture-local request
counter remained zero.

The machine-readable result is
`/private/tmp/lcu-browser-picker-20260928/browser-picker-live.json`, SHA-256
`9d708a4ac4db3005d715a9d8ce16f7631c7b9de39ba395b06bcdea835487e350`. This is
a live TUI happy-path result for Chrome; it does not establish macOS picker
behavior or live stale-target race handling.

## Interactive Pi picker smoke test

Live smoke completed 2026-09-27 in disposable container `lcu-verification:arm64`
with `--network none`. The test used Pi `0.87.1`, current-checkout adapter and
runtime source built inside the container as LCU `0.4.1`, and the original
ChatGPT Linux ARM64 package
`/private/tmp/lcu-exact-pins-20260926/chatgpt_26.915.31945_arm64.deb` whose
SHA-256 matched the pinned value
`b94c494b5f0fd7c720fa6fccd5ef609879affc62332ca930ed29b907d537bc6d`. LCU
reported ChatGPT `26.915.31945`, CUA
`0.0.16/20260915001755-492f19756c31`. The temporary build skipped only
`provision_agents` and provided an empty `agent-tools/` directory; it copied the
current adapter source unchanged. No Pi or provider credentials were mounted.
Pi reported no available models, the container had no network, and no prompt
was submitted. Pi created a 2-byte, empty `auth.json` in the disposable test
home; it contained no entries or credential values.

An actual original `cua.listApps({emit:false})` call returned 20 app entries.
The real Pi terminal menu selected `File Manager` and appended its original
app ID and guidance while preserving the existing `PICKER-DRAFT-KEEP-THIS`
draft. After clearing the test draft, literal `/lcu pick` was typed at the Pi
prompt and dispatched through the TUI; selecting `Appearance` inserted
`xfce-ui-settings.desktop` guidance. Neither prompt was submitted. Process
inspection found no selected app process and no Firefox, Chromium, or Chrome
process. Selection itself called neither the original `getApp` action, browser
tab claim, nor browser launch API. The fake surface in this fixture had the
computer-only runtime, so browser inventory was unavailable; its warning did
not prevent the native-app flow. This is a live native-app picker pass, not a
browser-tab picker or macOS acceptance claim.

For reproduction, run Pi in the disposable guest with only the installed LCU
extension and no startup prompt:

```sh
pi --no-session --no-tools --no-extensions \
  --extension "$HOME/.local/share/lcu/pi/extension.mjs"
```

The Pi 0.87.1 native Stop fixture makes model tool calls and must use
`--no-builtin-tools`, not `--no-tools`. In this release, `--no-tools` suppresses
all tools, including LCU's registered original `js` tool; `--no-builtin-tools`
removes Pi's local shell and file tools while keeping extension tools available.
The initial live Stop fixture used the former flag, so Pi correctly returned
`Tool js not found` before contacting the trusted macOS control service. This
was a fixture configuration error, not an adapter or host-service failure.
Pi's tagged 0.87.1 [`args.ts`](https://raw.githubusercontent.com/earendil-works/pi/v0.87.1/packages/coding-agent/src/cli/args.ts)
parses the flags separately, [`main.ts`](https://raw.githubusercontent.com/earendil-works/pi/v0.87.1/packages/coding-agent/src/main.ts)
maps them to `noTools: 'all'` and `noTools: 'builtin'`, and
[`agent-session.ts`](https://raw.githubusercontent.com/earendil-works/pi/v0.87.1/packages/coding-agent/src/core/agent-session.ts)
filters unavailable tool names when it builds its registry. The earlier picker
smoke command above makes no model request, so its `--no-tools` flag remains
appropriate.

A network-disabled disposable Pi 0.87.1 reproduction with current adapter
source and `--no-builtin-tools` then passed two actual MCP `js` calls; the
provider request advertised `js`/`js_reset` with the original description, and
turn cleanup passed. The existing broader Pi product test reached those
checks and failed later at an unrelated generated `lcu-fixture`
skill-injection assertion. This establishes the corrected tool registration
path, not a pass of that broader suite.

This smoke invokes Pi's actual extension dispatcher, selection UI, and editor
API plus original native-app inventory. It sends no model/provider request
because no prompt is submitted. It does not test browser-tab inventory or
selection against a running browser, nor the native action or Stop effect.
