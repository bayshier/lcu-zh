# Live macOS multi-turn turn-ended run, 2026-10-07

Live check for [#23](https://github.com/amontlabs/lcu/issues/23) and PR #24. At the
user's request it ran on the user's own macOS host, not the UTM verification guest.
**Result: the PR's slow path was not exercised.** On this host the signed
`SkyComputerUseClient turn-ended` command finished in 11–100 ms. It never took the
~5.2 s reported in #23, so origin/main and this branch behaved the same.

## Host and app

| Item | Value |
| --- | --- |
| Machine | User's macOS host (not the guest), macOS 26.5 (25F71), arm64 |
| ChatGPT.app | 26.930.21537 (build 12776), signed `com.openai.codex`, team 2DC432GLL2 |
| CUA runtime | 0.0.27/20260927214556-b77d38801cca |
| Tested pair | No (`tested-versions.json` lists 26.928.20755 with this runtime; informational only) |
| Codex Computer Use.app | 26.929.1001365 |
| `SkyComputerUseClient` SHA-256 | `1092710656ed437747359ffa32a87447220055f6d11f2a9c3b2f7810f1841f4c` |
| #23 reporter | ChatGPT 26.930.31730, same runtime, macOS 26.5.1 |

## Harness

- Two scratch roots under `/private/tmp`, one per code version: `git archive` of `lcu/`, `bin/` and
  `runtime.lock.json` at origin/main `1180362` and at branch `61b9763`, plus an `app` link to
  `/Applications/ChatGPT.app` and the installed `installation.json`. No setup ran and no agent was registered.
  `CODEX_HOME` and `LCU_LOG_DIR` were set to scratch paths.
- A Node script ran `createCuaClient()` from `adapters/client.mjs` against `<root>/bin/lcu`. One
  MCP server process served 4 turns in one session. Each turn ran one `js` call containing
  `cua.computer.list_apps()` and `cua.computer.get_app_state({app: "com.apple.finder"})` (Finder is
  always-allowed), then called `turnEnded(Stop)`. The next turn started as soon as that returned.
  The actions only read state: no clicks, typing or keys.
- A scratch-only copy of the branch's `macos_sky_service.mjs` recorded timestamps in memory and
  returned them through a scratch-only RPC. It recorded the hook start, the CLI step start and end,
  and each Sky request entry. Output from the trusted worker's `console.error` does not reach the MCP
  client's stderr, so this was the only way to see the wrapper's timings. The repository code was
  not changed.
- To time the command directly, a script ran the signed command 3 times with no service running
  and 133 times while a Sky action was in progress. It used dummy IDs and the same payload shape.

## Results

The native step's duration is the time from the hook starting to the CLI step starting.
"Next request wait" is how long the next turn's first Sky request waited before dispatch.

| Run | Turn | `turn_ended` MCP | Native step | CLI step (lifetime round trip) | Next turn's first `list_apps` | Result |
| --- | --- | --- | --- | --- | --- | --- |
| origin/main | 1–4 | 36, 13, 15, 15 ms | not instrumented | inside the hook | 8, 8, 9 ms | all 8 Sky actions ok |
| branch | 1–4 | 24, 1, 1, 1 ms | not instrumented | in the background | 23, 22, 22 ms | all 8 Sky actions ok |
| branch, instrumented | 1–4 | 23, 1, 1, 1 ms | 22, 1, 1, 1 ms | 14, 14, 12, 12 ms, `notified: true` | 21, 23, 21 ms (waited ~11–14 ms for the CLI) | all 8 Sky actions ok |

- Signed command run directly: 11–12 ms with no service running. While the service was running it
  took 31–100 ms over 133 runs. Every run exited 0 with empty stdout and stderr.
- The branch's host logs the command only when it fails or takes 4.5 s or more. It logged nothing,
  which matches the measured times. The diagnostic log recorded `turn_end outcome=ok` for every turn
  in both versions.
- origin/main's 3 s timeout never triggered, so the failure in #23 (the command killed at 3 s and
  later Sky requests failing) did not reproduce here. This run gives no before/after comparison.
- On the branch the next Sky request waited for the background CLI step, as designed. Here that wait
  was ~12 ms.

## What this shows and what it does not

- Shown: on this host and app build, the branch keeps computer use working across 4 turns in one MCP
  process. The hook returns after the native step. The background command finishes with exit 0 and is
  awaited by the next Sky request.
- Not shown: the 10 s allowance, the background run of a ~5 s command, and the retry-once-then-drop
  policy with the real helper. The ~5.2 s duration and its stated cause (the helper launching the CUA
  service and waiting up to 5 s for XPC) were not observed. Here the command did not launch the service.
  The difference may depend on the app build (26.930.31730 for the reporter) or on whether the ChatGPT
  app was running. The ChatGPT app was not running and was not launched for this test.
- Not shown: delivery to the service. Exit 0 is not proof of delivery, and os_log redacts the
  client's messages. Visible cursor removal was also not checked.

## Rerun after the app update, ChatGPT app running

The user updated ChatGPT.app by hand and left it running. The same harness ran on fresh scratch roots
from origin/main `1180362` and branch `61b9763`. The roots' `installation.json` was generated from the
installed app, as LCU resolves it.

| Item | Value |
| --- | --- |
| ChatGPT.app | 26.930.61225 (build 13232), signature verifies (`codesign --verify --deep --strict`), `com.openai.codex`, team 2DC432GLL2 |
| CUA runtime | 0.0.27/20260927214556-b77d38801cca (unchanged; pair not in `tested-versions.json`) |
| `SkyComputerUseClient` | unchanged, same SHA-256 as above |
| Running CUA services | two `SkyComputerUseService` processes: the bundled copy and `~/.codex/computer-use/Codex Computer Use.app` (same version 26.929.1001365, same binary hash) |
| Chrome/Chromium `com.openai.codexextension.json` | unchanged by the update: SHA-256 `a4e76915…a6be`, mtime Sep 25, path `~/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome` |

Results:

- Signed command run directly with dummy IDs: 96–117 ms over 8 runs, exit 0, empty stdout/stderr.
- **Every Sky request failed in both versions**, including turn 1 before any turn ended. The error was
  `Sky Computer Use native pipe startup failed`, after about 5.4 s, or 1.4 s for some requests.
- origin/main: `turn_ended` took 4001–4004 ms on all 4 turns, which is the hook's 4 s limit. The
  diagnostic log still recorded `outcome=ok`.
- Branch: `turn_ended` took 4002 ms on turn 1, when the native step hung on the failing pipe, and 0–1 ms
  on turns 2–4. Instrumentation explains this. Each later Sky request retried turn 1's failed native
  step and threw at the gate before its own turn metadata was recorded. So turns 2–4 had no native step,
  and the hook ran only the CLI step: 36, 16 and 14 ms, `notified: true`. The CLI step for turn 1 never
  ran because its native step never succeeded.
- No run produced a `turn-ended` command near 3 s or 5 s. The host's slow/failed log never fired.

Conclusion: #23 still does not reproduce here. With the app running, the Sky native pipe itself fails,
so this condition cannot show whether the fix keeps later requests working. The condition with the app
quit, on the updated build, was not run: the user left the app open and it was not quit for this test.
Before the update with the app not running, the earlier runs passed.

## Toggle check on 26.930.61225 and the cause of the pipe failure

The user approved quitting and relaunching ChatGPT for this check. Fresh scratch roots were used,
built the same way as before.

| Condition | Code | `turn_ended` (turns 1–4) | Next turn's first `list_apps` | Sky actions |
| --- | --- | --- | --- | --- |
| App quit, no CUA service running | origin/main | 37, 14, 16, 13 ms | 9, 8, 10 ms | 8/8 ok |
| App quit | branch | 23, 2, 3, 1 ms | 29, 28, 27 ms | 8/8 ok |
| App quit | branch, instrumented | 22, 2, 1, 1 ms; CLI step 19, 23, 18, 20 ms, `notified: true` | 27, 29, 27 ms | 8/8 ok |
| App relaunched; its own service (`~/.codex/computer-use/…`) holds the socket | origin/main | 38, 14, 15, 15 ms | 9, 9, 10 ms | 8/8 ok |
| App launched while an LCU-started bundled service already held the socket (both services running) | origin/main | n/a | n/a | 13/13 actions in the open process ok; a new LCU process was ok too |

With the app quit, the signed command took 30–33 ms over 4 runs, exit 0.

So the app running is not the trigger. The earlier failure was a temporary state, and os_log
from `SkyComputerUseService` shows how it arose:

- 00:20:23: a LaunchServices launch started the **bundled** service (pid 18916, ppid 1) from
  `/Applications/ChatGPT.app/…/@oai/sky/Codex Computer Use.app`. That is the path LCU passes as
  `SKY_CUA_SERVICE_PATH`. It took the socket lock.
- 00:21:03–00:21:08: the app update replaced `/Applications/ChatGPT.app` while that service kept
  running.
- 00:21:19: the relaunched app spawned its own service from `~/.codex/computer-use/…` (pid 20169).
  That service logged `socket lock is unavailable errno=35` 54 times until 00:25:37. This suggests
  the app's own computer use was also blocked; it was not checked in the app UI.
- 00:22:13–00:24:55, the time of the failing runs: the stale service rejected 1,338 client
  connections with `SlimCore.SkyIPCRequirement.Error.teamNotFound`. The Sky client then reported
  `native pipe startup failed`.
- 00:25:41: the stale service exited through AppKit automatic termination, about 45 s after its last
  connection attempt. The app's service then took the socket, and later runs passed.

A fresh service from the same binary accepts the same clients. So the rejection is most likely tied
to that process outliving the replacement of its bundle on disk. This is inferred from the logs
above; it was not reproduced, because that would require another app update.
