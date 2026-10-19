# Claude Code and GLM computer-use probe, 2026-09-25

**Current result:** guarded Claude Code 2.1.204 with real Z.ai GLM 5.3 Flash saved generated native GTK and AppKit fixtures through original LCU tools; both saves passed independent file oracles. A separate cold-first Linux MCP check also passed. Earlier Linux X11 and macOS TextEdit timeout failures remain unexplained. The fixture saves do not close Claude's per-turn cleanup gap. Details and retained sanitized evidence follow under [follow-up native save probes](#follow-up-native-save-probes).

## Initial macOS approval probe

A guarded normal Claude Code 2.1.204 session used an isolated configuration and a process-environment Z.ai endpoint (`https://api.z.ai/api/anthropic`). The real `GLM-5.3-Flash` model replied `READY`. This was a real-model session, not a scripted-provider fixture.

At test time, the selected signed ChatGPT app was 26.917.71314, newer than the LCU-pinned 26.917.62051. LCU rejected it before exposing tools. Reinstalling the frozen archive against the preserved, code-signature-verified 26.917.62051 app restored the LCU MCP connection. Claude's `/mcp` server inventory showed four original tools; the installed exact deny rules kept the two host-only tools out of the model-visible set, as established by the prior scripted-provider check.

The model called original `mcp__lcu__js` to inspect TextEdit. Claude displayed the original elicitation prompt, `Allow Computer Use to use "TextEdit"?`, with Accept and Decline choices. Decline returned `Computer Use was not approved to use TextEdit` and blocked the tool action. On a retry, accepting reached the original LCU server, which returned `-10005 timeoutReached` before a native action was confirmed. The agent observed the acceptance; the model's later claim that it received no answer was inaccurate and is not evidence of the UI result. No native save is claimed from this macOS attempt.

The original native helper was not stopped, replaced, or modified. The existing `SkyComputerUseService` appeared to use the original shared group-container socket and LaunchServices fallback, so a conflict is plausible but unproven. The timeout's cause remains unresolved. This test establishes that Claude Code's built-in MCP elicitation UI can render and return the approval decision; it does not establish successful native execution on this Mac after the app update.

Anthropic's [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests) says form and URL elicitation dialogs appear automatically without user-side configuration. The implementation needed to deliver this existing approval UI was already present; no replacement approval implementation was added.

## Initial Linux native GTK probe

The backend was a disposable network-disabled Linux ARM64 container named `lcu-claude-glm-native`, using LCU 0.3.0 from the final `00f47db` ARM64 archive (SHA-256 `0dda40b7f3e975e4a3bba4c242f4ed99486ead681b9f5b2e3045be37b1ff0cb9`) and the pinned official ChatGPT Linux 26.915.31945/CUA 0.0.16 runtime. It ran Xvfb `:99` and the generated `LCU Target` and `LCU Other` GTK windows. Claude Code 2.1.204 ran on the host with an isolated configuration; its project MCP command relayed through `docker exec` to the original LCU runtime, and the isolated project contained the platform-correct generated Linux skill. A real Z.ai GLM 5.3 Flash session connected to the MCP server and showed `lcu connected · 4 tools`.

No model-directed native Save or independent GTK oracle pass occurred in this run.

A paired direct-SDK diagnostic used the same installed adapter, command, `getState` request, session/turn shape, MCP capabilities, X11 display, D-Bus address, and GTK environment, changing only the container UID. The `ubuntu` process returned `apps: []` with an X11 `Operation not permitted` error; the root process's `getState` did not return that X11 error. This is a bounded UID comparison and does not establish why the runtime's sandboxed access differs. No sandbox was disabled or changed.

Claude's real-model original `js` call against the Linux GTK backend returned X11 `Operation not permitted` under both the ordinary `ubuntu` UID and a retry whose MCP worker process tree was verified as root. In the controlled direct-SDK comparison, root's `getState` did not return the X11 error that appeared under `ubuntu`, but that result did not carry over to Claude's actual worker chain. The cause remains unresolved. The GTK Target and Other windows were present, but Claude made no UI edit or save. The independent `Target.txt` and `Other.txt` oracle files were both absent. The isolated Claude shell exited after its provider environment variables were unset, temporary state was removed, and the disposable container was stopped and removed. No model-driven desktop save through Claude Code passed.

## Known lifecycle boundary

The elicitation result does not close the separate per-turn lifecycle gap. Claude Code's current LCU registration still does not send original `turn_ended` on normal completion or interruption; see the [lifecycle probe](claude-lifecycle-2026-09-24.md).

## Follow-up native save probes

Later on 2026-09-25, the same guarded Claude Code 2.1.204 and real Z.ai GLM 5.3 Flash setup completed original LCU saves on both Linux and macOS. These are separate generated GTK and AppKit fixtures; they do not erase the earlier failures or resolve their causes.

On Linux, one fresh offline pinned ARM64 container passed a cold-first original MCP check with no prior `doctor` or native call. In a separate fresh pinned setup, Claude called original `getState`, `listWindows`, and `getApp` against generated GTK Target and Other windows, edited the Target, and clicked Save. The original API returned `Saved: Claude LCU verified 2026-09-25`; the independent host oracle contained that exact text in `Target.txt` and `Other.txt` was absent. The earlier X11 `Operation not permitted` result was not reproduced in either check; its cause remains unknown, and no production runtime change was made.

On macOS, Claude accepted the original app-access elicitation for generated AppKit fixture `dev.lcu.NativeFixture.20260925`, set its field to `Claude LCU Mac verified 2026-09-25`, and clicked Save. The independent `NativeFixture.txt` oracle contained that exact 34-byte marker. The pinned original policy requests elicitation per operation and attaches persistence metadata (`session`, and `always` when allowed). The elicitation appeared again during later calls, but the sanitized record does not contain the raw request or response metadata, so it does not establish which persistence value Claude received or how it handled it. The [macOS helper investigation](macos-helper-timeout-2026-09-25.md) records Codex's separate session-persistence handler; this observation does not prove why Claude showed repeated prompts. This fixture save succeeds after the earlier accepted TextEdit request timed out; the TextEdit timeout remains unexplained.

Both fixture saves were driven by the real model through Claude Code and original LCU tools. Sanitized evidence is retained at `/private/tmp/lcu-claude-linux-repro/evidence.json` (SHA-256 `c49054b78961d1eda34277574d8ad58b44c26596fcbf19c93e74ed7986f2e048`) and `/private/tmp/lcu-claude-linux-repro/mac-evidence.json` (SHA-256 `c0700c03c331d9bedac3ce64b52234915196f6d7985e9a4532a7fd3b0a117cc0`). The later optional screenshot request was canceled after the Mac save oracle passed; it was not part of the save result. These results establish native task success for the generated Linux and macOS fixtures, not automatic per-turn cleanup, arbitrary app behavior, or a fix for the earlier timeout and X11 failures.
