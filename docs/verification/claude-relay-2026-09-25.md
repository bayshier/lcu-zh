# Claude Code relay lifecycle evidence, 2026-09-25

The guarded checks used Claude Code 2.1.204, a test-only scripted provider, and a localhost browser fixture. The corrected source `f1f5a0c` was installed under a fresh task-owned prefix and used the pinned staged ChatGPT app at `/private/tmp/lcu-mac-guest-staging-20260924/ChatGPT.app`. The existing task-owned Chrome profile and its registered official extension were reused. No paid provider, account credential, or unrelated tab was used.

## Installed relay and normal Stop

The installed relay connected through the official MCP SDK. Claude's model-visible tool list contained `js` and `js_reset`; its settings denied the host-only tools. `PreToolUse` supplied the actual Claude session, prompt, and tool-use IDs to the hidden context tool. The original JavaScript runtime received matching session and turn metadata. A normal `Stop` dispatched original `turn_ended(Stop)`.

The corrected installed relay created localhost Chrome tab `1223514033`. After normal Stop, `cua.listTabs` returned only the two pre-existing profile tabs, `1223514025` and `1223514030`. The generated test tab was gone; both baseline tabs remained. This verifies temporary-tab cleanup on normal Stop with the corrected installed archive.

An earlier source-overlay run of the relay displayed the original native-app approval form. The operator selected **Allow for this session**, then the generated app was opened with `getApp`, edited with `setValue`, saved with `click`, and checked with `getAXState`. An independent read of `/private/tmp/lcu-claude-native-live-20260925/draft.txt` matched the exact 27 bytes `claude-relay-saved-20260925` with no newline. The corrected installed archive was not separately used for another native save. Earlier direct-server GTK/AppKit saves predate the relay and are not relay evidence.

## Active-call Escape and direct-runtime comparison

A disposable trace-only copy of the corrected relay recorded a long JavaScript call and Escape. The downstream SDK signal was aborted at `2026-09-25T16:12:04.160Z`. At `16:12:04.161Z`, the relay sent original `turn_ended` with `hook_event_name: Interrupt` and the same bound session/turn pair. The identities are represented in the local trace by consistent SHA-256 prefixes `80e97fedf8` and `772e756893`. The SDK call timed out at `16:14:04.163Z`, its 120-second request limit. The JavaScript fixture was scheduled to finish after 180 seconds. At `16:16:34Z`, `cua.listTabs` showed only the two baseline tabs. The temporary tab had disappeared, but the timed-out request produced no captured cleanup response.

A direct official-SDK comparison against the same original runtime opened another localhost fixture tab, started a 30-second JavaScript wait, and sent matching `turn_ended(Interrupt)` while JavaScript was active. The call returned `isError: false` after 30.183 seconds, when JavaScript completed; the later client abort found no outstanding JS request. The subsequent tab list again contained only baseline IDs `1223514025` and `1223514030`. This reproduces the wait without the Claude relay. A separate 8-second client-timeout control sent Interrupt first, then cancelled the JS request; the next call after the 30-second interval also saw only the baseline tabs. The evidence does not identify which original host layer waits for the active JavaScript call; no relay workaround or new timeout was added.

Esc while Claude is waiting for a model response after a tool has finished emits no hook or MCP cancellation in the tested host. `StopFailure` is configured to send matching `Interrupt`, but was not observed live. No subagent or Windows real-model parity is claimed.

## Setup and checks

The project-scoped settings were generated in the disposable project with the source `configure(..., scope="project", chrome=True)` path and the corrected installed runtime. The `lcu setup --chrome` attempt could not create `/Users/polarzero/.local/state/lcu/setup.lock` inside the restricted test sandbox. This was a sandbox write restriction, not an automatic-review rejection; no account-level setup was performed. The live settings were restored to the corrected installed relay after tracing.

The default sandbox's read-only signature check falsely failed on the pinned app. A scoped, read-only `codesign --verify --deep --strict` check against that exact staged app exited successfully. The app/helper was not copied, modified, or re-signed. Test-owned Claude, provider, and page-server processes were exited; the two baseline Chrome tabs were left untouched.

The adapter suite passed 13 tests and skipped 4 opt-in tests. Python visibility and setup-integration tests passed 17 tests. The [adapter notes](../ADAPTERS.md#claude-code-adapter) and [parity table](../PARITY-STATUS.md) summarize the supported paths and limits.
