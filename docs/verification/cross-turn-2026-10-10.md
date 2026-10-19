# Cross-turn Computer Use (Claude Code)

Date 2026-10-10. Observed on an Apple Silicon Mac with the installed ChatGPT app 26.930.61225 (CUA runtime 0.0.27/20260927214556-b77d38801cca) and LCU 0.10.0 for the repro, then this branch's relay for the results with the change. Claude Code 2.1.204, headless `claude -p --input-format stream-json` sessions. The original runtime's behavior below was observed, not changed: LCU only chooses which turn id the Claude relay sends.

## Observed facts (installed LCU 0.10.0)

| Fact | Evidence |
| --- | --- |
| The relay used Claude Code's prompt id as the upstream turn id (`PreToolUse` binds it, `Stop` and `SubagentStop` send `turn_ended`). Subagents share the parent's prompt id. | Relay source; relay diagnostic log events. |
| A main turn woken by a background task notification gets a new prompt id and its Computer Use calls work. | Live session: a background task finished, the woken turn called `getApp` on Calculator and succeeded. No bug here. |
| A foreground subagent finishing sent `turn_ended` for the shared id, and the parent's next call in the same turn was refused: "Computer Use is unavailable because the current turn ended. It will work again after the next user message." The original service keys ended turns by turn id. | Live session: main call ok, foreground subagent call ok, main call refused. |
| A background subagent still working after the parent's `Stop` was refused with the same message, because it shares the ended prompt id. | Live session: the main call before the subagent worked; the subagent's calls after the parent's `Stop` were refused. |

## Design

- Always: each subagent gets its own upstream turn id (a UUID hashed from agent id and prompt id), so `SubagentStop` ends only that subagent. With the setting off, a parent `Stop` or `Interrupt` still ends its live subagents upstream, and a subagent started after its prompt ended shares the ended id, which is the behavior before the change.
- Setting off: a parent `Stop` or `Interrupt` closes the prompt at once and fails closed (an unclear reply is not rolled back), then cascades `turn_ended` to its live subagents.
- Opt-in `lcu cross-turn on`: a key that binds again after its upstream turn ended (or while that end is in flight, or after a cascade) gets a fresh random upstream id, and a parent's `Stop` does not end its subagents. Per-app approvals (macOS and Windows) are unchanged.
- Relay state: one record per life of a turn key, so a cleanup targets its own life; live turns capped at 1024; ended keys and closed prompts in bounded sets of 65,536 each, evicted oldest first by last recorded end, with the prior behavior as the fallback for an extremely old evicted key or prompt.
- The setting is `~/.local/state/lcu/cross-turn.json` (Windows `%USERPROFILE%\AppData\Local\LCU\cross-turn.json`), read by the relay on each decision, so no restart. Missing, damaged or anything but `enabled: true` is off.
- `lcu cross-turn [status|on|off] [--json] [--unattended]`, `lcu setup --cross-turn on|off [--unattended]` (the Linux and macOS installer forwards both; the Windows installer does not accept them, so Windows uses the installed `lcu setup` or `lcu cross-turn`) and `cross_turn` in `lcu status --json`. On macOS `on` runs `bin/lcu-owner-auth` as `lcu apps allow` does; `off` and no-op changes never prompt. Linux and Windows have no owner prompt. The Linux and macOS installer forwards `--cross-turn` and `--unattended` and rejects them with `--runtime-only`; the Windows installer does not accept them. `--unattended` skips the prompt and records `unattended` for disposable sandbox machines.
- Not a security boundary: anything running as the account can edit the file or pass `--unattended`, as with the approved-apps list.
- Agents affected: only the Claude Code relay. Codex hooks carry Codex's own turn id; Pi (and Oh My Pi, which wraps it) uses a new `randomUUID()` per turn (`adapters/pi/index.ts`); the other agents do not read the setting. These were read in code, not run for this change.

## Live results with the change

Headless stream-json sessions with this branch's relay registered, the installed ChatGPT app, and a read-only, always-allowed `getApp` on Calculator as the Computer Use call. Each case used a main call, then a subagent call, then (foreground cases) another main call.

| Case | Setting | Result |
| --- | --- | --- |
| Foreground subagent, main call before and after | off | all calls ok |
| Background subagent working after the parent's `Stop` | off | subagent calls refused (the original rule) |
| Foreground subagent, main call before and after | on | all calls ok |
| Background subagent working after the parent's `Stop` | on | subagent calls ok |

The foreground case fails on 0.10.0 (second main call refused) and passes with either setting after the change. The final code (after review rounds) was rerun with the same four results. `on` was set with `lcu cross-turn on --unattended` from the worktree (no Touch ID prompt); `off` by removing the file or `lcu cross-turn off`.

## Owner prompt on the released 0.11.0 (2026-10-10)

On the same Mac, after `lcu update` from 0.10.0 to the published 0.11.0 archive (`lcu --version`: ChatGPT darwin 26.930.61225, CUA 0.0.27), the owner ran `lcu cross-turn on` from a terminal in the desktop session. It printed "Waiting for Touch ID or your password...", the system Touch ID prompt appeared, and after the owner approved it the command reported the setting on. `cross-turn.json` then held `"enabled": true, "source": "owner"`, and `lcu status --json` reported `cross_turn: {"enabled": true, "source": "owner"}`. `lcu cross-turn off` then turned it off with no prompt. A cancelled or failed prompt and `lcu setup --cross-turn on` were not exercised live.

## Tests added

- `adapters/test/claude.test.mjs`: the relay (including the fail-closed parent end, per-life records and the bounded history) against a fixture that refuses ended ids as the service does: fresh id with the setting on and prompt id with it off, subagents under the child identity, renewal after `Interrupt` (also with the `Interrupt` in flight, and a re-bind landing during cleanup), shutdown ending a renewed turn with its fresh id, a foreground subagent never ending the parent (on or off), and a background subagent after the parent's `Stop` (refused off, works on); the setting path and parser.
- `tests/node/cross_turn.test.mjs`: status and JSON, authentication once on macOS with the release root, idempotence, `off` without a prompt, cancelled, failed or unavailable authentication changing nothing, `--unattended`, Linux and Windows without a prompt, damaged and unreadable files, usage errors.
- `tests/node/setup.test.mjs`, `tests/node/status.test.mjs`, `tests/node/install.test.mjs`: the setup flag, the interactive question and declined or cancelled cases, `cross_turn` in status, installer forwarding. `tests/test_build_platforms.py` and `scripts/provision_agent_tools.py`: `adapters/cross-turn.mjs` ships in the archive.

On the macOS machine above, with the final code: `node --test tests/node/` passed 408, failed 0, skipped 29 (the Linux-only cases), `npm test` in `adapters/` passed 154, failed 0, skipped 8 (the installed-Pi cases), and `python3 -m unittest tests.test_build_platforms tests.test_hermes_harness` passed 9. The reviewing agent ran the Linux-only node tests (cross_turn, setup, status, install) in disposable Docker (Node 22.23.3), as root and as non-root: 72 passed, 3 skipped, 0 failed each time.

## Not verified

- A cancelled or failed live Touch ID prompt, and the prompt reached through `lcu setup --cross-turn on` or the interactive setup question. Tests cover these with an injected authenticator and stand-in helpers. An approved prompt for `lcu cross-turn on` was verified live (above).
- The interactive Claude Code TUI and the Claude desktop app. Only headless stream-json sessions were run.
- Linux and Windows desktops. The Linux and Windows behavior (no owner prompt, state path, Windows per-app approval note) is covered by unit tests only.
- `tests/run.sh` (the full container gate) and a native Linux desktop run were not run for this change; the Docker runs above are unit tests with skips, not desktop evidence.
- Codex, Pi, Oh My Pi and Hermes with the setting on (they ignore it by design, checked in code only).
- Whether future Claude Code versions keep sharing the prompt id between a parent and its subagents.
