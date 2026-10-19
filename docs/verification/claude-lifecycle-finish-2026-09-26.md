# Claude lifecycle verification, 2026-09-26

Claude Code child tool calls now receive independent LCU turn identities, and `SubagentStop` performs per-child cleanup. The adapter maps a child’s `agent_id` to its LCU `session_id` and preserves the shared `prompt_id` as `turn_id`. Parent `Stop` remains scoped to the parent session.

The pinned original plugin manifest was restored from the exact app package and had SHA-256 `cc6503bbcb33ead0d71459903bf3b7900bb29ae18e40236373027a001ef2317e`. Its `Stop` and `Interrupt` hooks pass `${session_id}` and `${turn_id}` to `turn_ended`; its `SubagentStop` hook passes `${agent_id}` as `session_id` and `${turn_id}`. The Claude visibility installer keeps the existing `StopFailure` to `Interrupt` mapping and adds the child cleanup hook.

The [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) defines `prompt_id` as a common hook field for Claude Code 2.1.196 and later; `SubagentStop` adds `agent_id`. The installed guarded Claude Code version was 2.1.204. Its captured `PreToolUse` and `SubagentStop` payloads included both fields, matching that versioned reference.

## Child isolation and cleanup

A guarded Claude Code 2.1.204 run used a generated project, isolated HOME, synthetic provider, and local LCU result fixture. The provider advertised the host’s actual `Agent` tool and scheduled a parent call plus two overlapping child calls. It returned only synthetic tool results. All three LCU calls completed, both child `SubagentStop` events reached `turn_ended`, and the parent `Stop` reached `turn_ended` afterward.

The host payloads showed one parent session and prompt shared by both children, with distinct agent IDs. Sanitized SHA-256 prefixes recorded for that run were:

| Context | Host `session_id` | `agent_id` | `prompt_id` | LCU `session_id` | LCU `turn_id` |
| --- | --- | --- | --- | --- | --- |
| Parent | `47b9d34bf3ea` | — | `ab8f3c6e39c0` | `47b9d34bf3ea` | `ab8f3c6e39c0` |
| Child A | `47b9d34bf3ea` | `f2032920bc40` | `ab8f3c6e39c0` | `f2032920bc40` | `ab8f3c6e39c0` |
| Child B | `47b9d34bf3ea` | `2659ad2fd7f3` | `ab8f3c6e39c0` | `2659ad2fd7f3` | `ab8f3c6e39c0` |

Each child cleanup used that child’s `agent_id` and the shared prompt ID. The parent stop used the parent session and same prompt ID. The fixture recorded one cleanup per child; the SDK regression also repeats child A cleanup and confirms it is idempotent, blocks stale child calls, and confirms cleanup of one child or the parent does not clear the other child’s context. The pre-fix live relay forwarded parent and child calls with the shared host session/prompt pair; the regression now asserts the separate LCU session identifiers.

## API-failure boundary

The guarded host was then run once with an active exact LCU context. A synthetic provider returned a successful `mcp__lcu__js` call first, then returned HTTP 400 with the documented `invalid_request_error` JSON shape on the next model request. The fake fixture key matched; the provider saw exactly two requests (200, then 400), including the tool result in the second request. The [Claude API error reference](https://platform.claude.com/docs/en/api/errors) documents HTTP 400 `invalid_request_error` and the JSON error envelope used by this fixture.

The resulting Claude Code `PreToolUse` and command-hook `StopFailure` payloads had matching sanitized identities:

- Session: `24f8d3a6d688`
- Prompt: `585811ba1b1b`
- Tool use: `2791e5e0cb5b`
- StopFailure `error`: `unknown`

The host emitted `StopFailure` and included `last_assistant_message`; this payload omitted optional `error_details`. The CLI printed the synthetic 400 error and exited with status 1. The configured LCU MCP `Interrupt` callback did not appear in the downstream fixture after that active tool call. The cause is not established. This run verifies the host failure event and its matching context, but does not verify LCU cleanup on this failure path.

## Checks and scope

Focused checks passed:

- `node --test adapters/test/claude.test.mjs` — 6 tests passed.
- `python3 -m unittest tests.test_claude_visibility` — 5 tests passed.

Host probes used the guarded installed `clod` launcher, a real TTY, the literal `START CLAUDE`, isolated temporary HOME/project directories, a fake local API key, and a provider bound to `127.0.0.1`. No OAuth credentials, real API key, personal content, or external provider request was used. Raw provider request bodies and hook payloads remain in temporary local fixtures and are not part of this repository; this note records only field names, event outcomes, and hashed IDs. The scripted provider verifies transport and lifecycle metadata, not model-generated wording or desktop-installed runtime behavior.
