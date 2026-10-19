# Persistent macOS cursor investigation, 2026-09-27

A user reported a computer-use cursor remaining at the last click after a Pi
task completed. The supplied image is consistent with a native agent cursor
overlay. The exact session was not reproduced or inspected. Source inspection
found a macOS native lifecycle gap consistent with the report; it does not prove
that this gap caused the photographed overlay.

## Observed lifecycle wiring

- `adapters/pi/index.ts` registers `agent_end` and sends Stop or Interrupt with
  the same session/turn identifiers used for tool calls.
- `adapters/client.mjs` sends those identifiers to the original hidden
  `turn_ended` MCP tool. This proves notification dispatch, not native cleanup.
- `lcu/runtime.py` selects the original signed macOS helper through
  `SKY_CUA_SERVICE_PATH`. It has no macOS native turn-ended bridge. The separate
  Windows lifecycle bridge is not selected on macOS.
- In the selected app, original Sky `service.js` handles setup, execute and drag
  requests without registering `addTurnEndedHandler`. Its macOS
  `native-pipe.js` implements ping and request transport without a native
  turn-ended notification. The original CUA REPL README describes hidden
  `turn_ended` as a host cleanup notification; it does not establish that every
  native host is subscribed.

The original signed client at
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`
lists a `turn-ended` subcommand. Its read-only help reports a required payload
and an optional `--previous-notify` argument. No payload was sent. Binary strings
also contain `CodexTurnEndedNotification`, `agent-turn-complete`, `thread-id`
and `turn-id`; these names alone do not establish the complete payload contract
or command behavior.

There is also a separate Pi failure-handling defect: `finish()` clears `active`
before awaiting `bridge.turnEnded()`. A failed end notification therefore loses
the identifiers needed to retry on session shutdown. The installed Pi 0.86.0
awaits `agent_end` in `dist/core/agent-session.js` and catches extension handler
errors in `dist/core/extensions/runner.js`, so a finished agent loop does not
prove successful cleanup. No evidence establishes that an error occurred in
the reported session.

## Fix and acceptance criteria

Reuse the selected original macOS client's lifecycle command through LCU host
lifetime wiring. First establish its payload and matching semantics in a
disposable macOS desktop. Keep tool behavior, native transport, and cursor
implementation in the original runtime. Preserve failed cleanup ownership so
the adapter can report and retry failures without silently reusing a dirty
turn. Normal completion, interruption and shutdown must all reach cleanup.

The regression must click a disposable native fixture, observe the agent
cursor, complete the Pi turn while Pi stays open, and independently confirm the
cursor disappears. Repeat for interruption and cleanup failure. Verify stale
or duplicate cleanup cannot remove another active turn's cursor. A successful
MCP response or a recorded callback is insufficient.

At the investigation checkpoint, existing Pi tests asserted notification dispatch,
and prior native tests asserted saved text. Neither verified macOS cursor removal.
The following implementation adds bounded lifecycle checks; platform support and
prior desktop verification limits remain unchanged.

## Official installed-source identity

The inspected app reports ChatGPT `26.924.22138`, build `11645`; the preceding
[current-app check](macos-current-app-2026-09-26.md) records signature validation
for this version. This investigation did not re-run that validation. SHA-256
values below identify inspected files only, not compatibility allowlists:

| File relative to `cua_node/lib/node_modules/@oai/sky` | SHA-256 |
| --- | --- |
| `dist/project/cua/sky_js/src/service.js` | `5b2fa2f0e19c8401a9be8c71be17008d88049ab107972c1e4a5cb615f4ef5993` |
| `dist/project/cua/sky_js/src/targets/mac/native-pipe.js` | `2f1bcc0b4cd013ef3d267f6d93bd2aa29770712687c8db087d55ec9d173380e8` |
| `Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient` | `ba5705d80a32fdd766c43a90ff37975d463378cc45d94e3c83e0798d673ac1be` |

No original implementation or instruction contents were copied into the repository.

## Read-only turn-ended CLI payload mapping

A read-only disassembly of the selected `SkyComputerUseClient` confirms that
`turn-ended` takes a positional JSON payload. Its notification decoder maps
`type` to the `agent-turn-complete` discriminator and maps `threadID` and
`turnID` properties from the JSON keys `thread-id` and `turn-id`. The CLI help
also exposes `--previous-notify <previous-notify>`; this inspection does not
establish that option's semantics.

The evidence is from the installed client binary with SHA-256
`ba5705d80a32fdd766c43a90ff37975d463378cc45d94e3c83e0798d673ac1be`:

- At `0x100094da0`, the decoder selects the `type` key; the following code
  constructs the `thread-id` and `turn-id` key strings at `0x100094db8` and
  `0x100094dd4`.
- At `0x100093e90`, the decoder compares the notification discriminator to
  `agent-turn-complete`.
- `SkyComputerUseClient turn-ended --help` reports
  `cua turn-ended [--previous-notify <previous-notify>] <payload>`.

This establishes CLI payload parsing and key spelling only. No payload command
was run against the local native helper, and no native callback, cursor
cleanup, stale-turn matching, duplicate handling, or `previous-notify`
behavior was verified.

## Implementation and quick verification

`lcu/macos_sky_service.mjs` forwards Sky calls to the original selected service and
registers the original runtime's turn-ended callback. It sends the exact session
and turn identifiers through the original `nodeRepl.nativePipe` bridge to a
private LCU lifetime host. `lcu/macos_host.py` invokes the selected signed client's
`turn-ended` command with the confirmed payload, bounded timeouts and no shell.
The original helper is neither modified nor terminated. The private host exists
only for its MCP process and is included in the thin macOS archive.

The original runtime can swallow a callback failure and return MCP success.
Consequently the service wrapper retains a failed native notification and retries
it before forwarding another Sky request. A repeated failure blocks that request
and is logged by the host. Host acknowledgement means the command exited zero;
it does not independently prove the native helper removed the cursor. Pending
service state does not survive a REPL reset or process crash.

Pi separately retains failed MCP cleanup identifiers, prevents tools on an ended
turn, retries before a new turn, and deduplicates overlapping completion/shutdown.
Repeated shutdown after disconnect does not launch another MCP process.

Quick checks performed:

- Offline disposable ARM64 container: 16 MCP-client, Pi, approval, retry and
  installed-Pi lifecycle checks passed, including a real Pi process with a local
  scripted model. Its first run exposed a duplicate end notification from
  overlapping completion/shutdown; the fix and regression now pass.
- Offline disposable ARM64 container: 10 macOS launcher/lifetime-host checks and
  four thin-archive checks passed using fake app/client fixtures.
- `python3 -B tests/macos_lifecycle.py` ran the installed original macOS ARM64
  MCP/Node REPL with isolated HOME/CODEX_HOME and the original sandbox. The
  official MCP SDK carried the calls. Original Sky setup ran without native
  desktop requests; a recording executable replaced only the native cleanup
  command. Independent argv records confirmed Stop, Interrupt, and retry of a
  failed callback with exact identifiers. No personal helper, GUI or credentials
  were used.

The existing disposable macOS UTM guest was running, but its backend rejected
`utmctl exec` and `ip-address` as unsupported. Thus visible cursor removal and
native stale-turn/duplicate behavior were not retested. No full release gate or
new platform support claim follows from these quick checks.
