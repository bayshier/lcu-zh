# Sky event taps after js_reset, 2026-10-10

While Lookout was being tested live through LCU (Claude Code), every keystroke was doubled system-wide until
the user killed `SkyComputerUseService`. This record covers the cause on LCU's side, the fix, and a bounded
live check of how Sky removes its event taps.

## Host and app

| Item | Value |
| --- | --- |
| Machine | User's macOS host (not the guest), macOS 26.5 (25F71), arm64 |
| ChatGPT.app | 26.930.61225 |
| CUA runtime | 0.0.27/20260927214556-b77d38801cca |
| Tested pair | No (`tested-versions.json` lists 26.928.20755 with this runtime; informational only) |
| Codex Computer Use.app | 26.929.1001365 |
| Installed LCU | 0.11.1 |

## Cause

- The Sky wrapper (`lcu/macos_sky_service.mjs`) registers its turn-ended hook with `addTurnEndedHandler` at the
  first Sky request and keeps the pending turn metadata in the trusted worker. `js_reset` stops that worker.
- The diagnostic log `claude-20261010T183211Z-13865.jsonl` shows `js_reset` at 18:52:24Z, 19:03:54Z and
  19:09:20Z. After each one, no `SkyComputerUseClient turn-ended` process ran for any turn end, although one
  ran for every turn end before. The relay logged those turn ends as `ok` in 0–1 ms.
- So Sky never got `ComputerUseIPCCodexTurnEndedRequest` for those turns. A `CGGetEventTapList` listing taken
  afterwards showed the service still holding a global active tap (mask `0x200000`), a `0x1c00` keyboard tap on
  ViewBridgeAuxiliary and, for the target app's pid, two `0x182000` and two `0x1c00` active taps: the
  per-app focus-enforcer taps, installed twice.

## Live check of tap removal

The check was bounded and approved by the user. `createCuaClient()` from `adapters/client.mjs` ran the
installed `lcu` (0.11.1) on Calculator, which the user always allows. Each run read Calculator's state, sent it
one Escape key, and listed the service's taps with `CGGetEventTapList` after each step.

| Step | Run 1 (AppStop) | Run 2 (control) |
| --- | --- | --- |
| After `get_app_state` | 1 listen-only tap | 1 listen-only tap |
| After `press_key` | 6: global `0x200000`, ViewBridgeAuxiliary `0x1c00`, Calculator pid `0x182000` + `0x1c00`, 2 listen-only | same 6 |
| After `ComputerUseIPCAppStopRequest` (host control) | 0 | not sent |
| After the turn end (+7 s) | 0 | 0 |

**Result:** a turn end that reaches Sky removes every tap, the per-app enforcer taps included, and so does
AppStop. AppStop is therefore not added to LCU's turn cleanup. The fix is to make sure the turn end reaches
Sky. This check did not reproduce the doubled per-pid taps.

## Fix

- The Claude, Codex and shared client relays: before forwarding `js_reset`, each turn that ran `js` on the
  current worker gets `turn_ended` (Interrupt) while the worker still lives, then continues under a fresh
  upstream turn id, so the original service does not refuse its later calls.
- `turn_end` diagnostic events carry `sky_hook`: `live` when the worker the turn ran on still runs, `reset`
  when that worker was reset since (the end reached no hook), `none` when the turn ran no `js` since its last
  reset. Reset-time ends are logged with `cause: "js_reset"`.
- The macOS lifetime host learns each turn at its first Sky request, and when it stops it runs the original
  `turn-ended` command (8 s bound) for every turn no turn-ended request named.

Unit tests: `adapters/test/{claude,client,codex}.test.mjs`, `tests/node/macos_host.test.mjs` and
`tests/macos_control_service.mjs`. `tests/run.sh linux/arm64` passed.

## Live run of the fixed Claude relay

This run was approved by the user. The repository's `adapters/claude.mjs` ran in front of the installed `lcu`
(0.11.1), with cross-turn off. All steps were in one turn on Calculator, and each `js` call ran
`get_app_state` and then `press_key` Escape.

| Step | Sky taps | Relay log |
| --- | --- | --- |
| `js` | 6 (the same set as above) | `call_end` ok |
| `js_reset` (+1.5 s) | 0 | `turn_end` Interrupt, `cause: js_reset`, ok, `sky_hook: live` (51 ms) |
| `js` again, same turn | 6; the call was not refused | `call_end` ok |
| `Stop` (+2 s) | 0 | `turn_end` Stop, ok, `sky_hook: live` |

Before the fix, a `js_reset` left these taps in place until the service exited. In this run they were removed
at the reset, and the turn went on working under its fresh upstream id. Not run live: the Codex relay, the
shared client relay, and the lifetime host's cleanup at stop. The host change is in `lcu/`, which the installed
0.11.1 did not include.
