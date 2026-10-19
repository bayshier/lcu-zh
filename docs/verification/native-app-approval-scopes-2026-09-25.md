# Native app approval scopes, 2026-09-25

## Finding

The pinned original Mac CUA runtime honors the persistence scope returned in its native-app MCP elicitation. LCU only needed to expose and forward the user's selected scope; it did not need an approval cache or grant store.

The source request comes from the staged ChatGPT 26.917.62051 CUA runtime, `@oai/sky/dist/project/cua/sky_js/src/targets/mac/computer-use-policy.js`. For a generated fixture app it requested an empty `form`, marked `_meta.codex_approval_kind` as `mcp_tool_call`, set `_meta.connector_id` to `computer-use`, identified the app by generated bundle ID in `_meta.tool_params.app`, and advertised `persist: ['session', 'always']`. The sanitized captured request is `/private/tmp/lcu-native-approval-20260925-retry/original-elicitation-raw.json`; no original app source or documentation was copied into the repository.

## Original runtime checks

All checks used the exact staged original `cua-repl` and signed Mac helper, the official MCP SDK client, and generated AppKit fixture apps only. Each run used a task-owned temporary `CODEX_HOME`, a local generated bundle ID, and a fixture Save file. No browser, account credential, paid model, or personal app was involved.

| Response | Observed original behavior |
| --- | --- |
| `accept` with no `_meta.persist` | Eight elicitation callbacks occurred across `getApp`, `setValue`, `click`, `getAXState`, and the repeated sequence on a later turn. The operations themselves succeeded. |
| `accept` with `_meta.persist: 'session'` | One elicitation covered `getApp`, bound `setValue`, `click`, `getAXState`, and a repeated `getApp` on a later turn in the same original runtime session. Every call returned without error. |
| `accept` with `_meta.persist: 'always'` | A second original MCP bridge using a different session ID opened the same generated app without another elicitation. This verifies reuse across a fresh bridge and session. The test did not restart the native helper or establish a revocation path. No files appeared under the isolated temporary `CODEX_HOME`, so this record does not claim a durable settings-file location. |

A second generated fixture bundle still prompted after the first bundle had a session approval. Declining that second bundle caused the next request to prompt again. The fixture Save oracle at `/private/tmp/lcu-native-approval-20260925-retry/draft.txt` contained exactly 32 bytes, `LCU_ONCE_APPROVAL_CONTROL_REPEAT`, confirming the original Save action changed only the generated fixture.

## Pi scope forwarding

Pi 0.73.0 was run in its real terminal UI with the LCU Pi adapter, a local scripted provider, and the official MCP SDK fixture. The user-facing scope selector rendered the original message and these offered options: Allow once, Allow for this session, Always allow, and Decline. Selecting **Allow for this session** produced the exact original MCP response `{"_meta":{"persist":"session"},"action":"accept","content":{}}`; the adapter did not reinterpret or store it. Pi completed the turn and sent its normal `turn_ended` Stop event. The isolated run exited successfully; sanitized records are under `/private/tmp/lcu-pi-native-approval-20260925/`.

The deterministic adapter tests cover once, session, always, decline, cancellation, malformed requests, and a scope that the request did not offer. The helper exposes only persistence choices present in the original request and maps a missing or invalid selection to cancel. Browser-origin approval logic is unchanged.

## Combined Pi and original runtime check

A second generated AppKit fixture closed the gap between the Pi UI and the original server. Pi 0.73.0 ran with the pinned staged CUA runtime and signed helper, plus a local scripted provider. I selected **Allow for this session** once; the selector appeared once across three provider requests (`getApp`, then `setValue`/`click`/`getAXState`, then final response). The original Save file `/private/tmp/lcu-pi-original-native-20260925/draft.txt` contained exactly 46 bytes, `LCU_PI_ORIGINAL_RUNTIME_SESSION_SCOPE_20260925`. This demonstrates that the selected session response reached the original runtime and authorized the subsequent protected fixture operations without a second approval prompt. The generated app, logs, and isolated host state remained under `/private/tmp`; the run did not exercise helper restart or grant revocation.

This verifies the original runtime's observed session and always response behavior, plus Pi's selector and response forwarding. It does not prove persistence after native helper restart, application restart, or an explicit revoke operation. LCU adds no native approval storage.
