# Native macOS harness flows, 2026-09-28

OMP 18.4.1 passed a real model-driven native macOS edit/save flow with session approval. OMP also passed fresh-process reuse of an always grant. Hermes v2026.9.24 passed both the native session-approval flow and always-grant reuse across fresh processes. [Browser flows and the interactive approval matrices](harness-browser-flows-2026-09-28.md) passed separately.

## Environment and source boundary

The task-owned UTM guest `LCU macOS cold helper test` runs macOS 26.6.2 arm64 as `lcuverify` on `VirtualMac2,1`. Its [saved login procedure](macos-test-guest-access.md) was verified without changing the password. No test accessed the user's personal desktop.

The guest's installed `/Applications/ChatGPT.app` was reused in place. Its bundle identifier is `com.openai.codex`, version 26.917.62051, build 10789, signing team `2DC432GLL2`; deep strict signature verification passed. Its Node version is v24.21.0. LCU reports original runtime `0.0.16/20260915001755-492f19756c31`; the separate `@oai/cua-repl` package reports 0.1.0. The installed LCU prerequisite is 0.4.2.

The disposable test overlay used the committed OMP/Hermes adapters from `645520c` and three current lifecycle modules (`lcu/runtime.py`, `lcu/macos_host.py`, `lcu/macos_sky_service.mjs`) from the parallel macOS lifecycle work. This is not a clean-commit release verification. The private source manifest records each file hash. The original app and native helper were neither copied nor modified. Adapter dependencies and the selected app were linked from the existing guest installation.

The generated AppKit fixture was compiled on the host because the guest has no developer tools. Only this LCU-authored fixture binary was transferred, with SHA-256 `ef366e8205c0f6030315425cce7756f8af69f42419a66892f8381c7b6b2de724`. It generated a unique bundle identifier, saved the edited value to a separate file, and recorded its PID for exact cleanup. Its source/payload archive hash is `ae703adb1969d71ee50d7ac9fa4c83c7c8955d6afd6220ab9d7779beed6f2857`. No OpenAI binary or generated original instructions enter Git.

## OMP session approval

Official [OMP v18.4.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.4.1) ran inside the guest with a fresh HOME and profile. The arm64 CLI hash is `f5b9bb407e685f92f32e6c14d6dab64570d2a0c85a6a19d74fdce38c64e07d14`. Model `glm-5.3-flash` used a bounded host proxy; the existing provider credential remained on the host, outside the guest and agent profile.

The actual OMP selector offered Allow once, Allow for this session, Always allow, and Decline. PTY input chose session once. The model made successive original CUA calls against generated app `dev.lcu.NativeFixture.df288fcf614a456188ed580a0eb4691c`, edited the text field, clicked Save draft, and inspected accessibility state and screenshots. The independent saved file contained exactly `lcu-omp-29f7289a678c`. After normal agent completion, a narrow observer recorded the successful original `turnEnded` response with `Stop`, session `01a0e7fc-1ffa-76da-9ad4-fa4f1476d8fb`, and turn `154ec513-d367-4cf4-bf16-201f03ad8fe5`, before test teardown.

The run passed in 88.88 seconds. Private evidence is `/private/tmp/lcu-harness-full-20260928/omp-macos-session-evidence.json`; the archived queue job is `d4084530-bda5-4245-a0e2-a8939a847a66`. Raw terminal output can contain original instructions and remains outside Git. The `agent_process_still_in_tui` field was sampled after teardown; it is not evidence that OMP exited on its own.

This proves actual macOS actions and reuse of session approval across calls within the same OMP turn. It does not establish grant reuse after an agent/helper restart, audio behavior, or other platforms.

For guests without developer tools, build only the generated fixture with `xcrun swiftc -O -framework AppKit tests/macos_native_fixture.swift -o /path/to/private/staged/tests/macos_native_fixture.bin`. Place that binary beside the staged fixture shell and Swift source. The shell uses it instead of invoking the guest compiler. The binary is excluded from Git; the optional `LCU_FIXTURE_PID_FILE` records the exact fixture process for cleanup.

## OMP always approval across fresh processes

Two independent OMP processes reused one generated app, `dev.lcu.NativeFixture.ba4b88d849c74702b746c88cee9ee77e`, PID 8902. Process 8905 selected Always allow through the real TUI; the original MCP response was exactly `accept` with `persist: always`. Its three `js` calls saved `lcu-omp-18efbf82612f` and completed `Stop`. After that process was terminated, process 8930 made three `js` calls, saved a different marker `lcu-omp-a3a1b089ba2b`, and completed `Stop` with zero elicitation callbacks. Both independent file checks passed. Session and turn IDs differed between the processes.

Private evidence is `/private/tmp/lcu-harness-full-20260928/omp-macos-always-evidence.json`; the queue job is `596d7b9f-5ad9-4522-83d7-28f56f64fc1d`. A write-only observer in the disposable MCP client copy recorded successful tool calls, exact approval responses, and cleanup responses. It did not replace any call or decide approvals. The source harness owns no persistent grant cache.

This proves always-grant reuse across agent and MCP process replacement for the same native app. It does not prove persistence across a guest reboot, deliberate native-helper restart, app update, or revocation.

## Hermes TUI startup finding

Hermes v2026.9.24 (CLI 0.21.5) was installed in the guest from its official release source with the frozen dependency lock. Launching `--tui` from this source installation requires Node and npm to build the TUI workspace; the original app's private Node runtime does not include npm. The test uses a separate official Node v24.21.0 distribution for the Hermes TUI, while the LCU bridge continues to use the original app's Node runtime.

The new TUI dropped the initial `-q` query during real MCP startup: its terminal reported `startup query skipped: no active session`, then showed the ready session with `lcu_cua: js, js_reset`. No model request or native action occurred in that failed run. The test must submit through the ready composer when this occurs. Private diagnostic evidence is `/private/tmp/lcu-harness-full-20260928/hermes-tui-startup-race-evidence.json`. The [tagged TUI source](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/ui-tui/src/app/createGatewayEventHandler.ts#L640-L670) limits that startup wait to four seconds. The runner then uses the [ordinary composer paste/submit path](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/ui-tui/src/components/appLayout.tsx#L427-L436) once the UI reports ready. No Hermes source or adapter is changed to work around this startup-query timing issue.

## Hermes session approval

Official [Hermes v2026.9.24](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24), CLI 0.21.5 at source commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`, passed against the same original signed app. Its real `--tui` selector returned one `accept` with `persist: session`. Three original `js` calls saved exact marker `lcu-hermes-f986f9d380ff` in the independent file and completed `Stop`, session `20260928_055709_f25c30`, turn `20260928_055709_f25c30:20260928_055709_f25c30:3fb597bc`. The generated native app was `dev.lcu.NativeFixture.ce587e98976f4e3e9189fe4c7044e7b6`, PID 9386.

The startup-query fallback was exercised: the test submitted the original prompt through the ready composer. Private evidence is `/private/tmp/lcu-harness-full-20260928/hermes-macos-session-evidence.json`; queue job `a90ba84e-f0e6-4ddc-be8e-1d330ca01a29`. This proves real macOS edit/save behavior and session approval reuse across calls in one Hermes turn.

## Reproduction

`tests/macos_harness_live.py` is an opt-in real-model integration runner for the disposable Apple Silicon macOS guest. It refuses a different account or non-virtual hardware, validates the installed official app identity and signature, and uses a fresh agent profile and generated AppKit fixture. It observes the original MCP responses and checks an independent saved file. Session mode runs one process; always mode replaces the agent and MCP processes and requires the second turn to complete with zero elicitation callbacks. Failure evidence retains the terminal tail, tool/cleanup traces, and oracle value. Raw evidence stays private because terminal output can contain original runtime instructions.

Stage a source/release tree, the prebuilt LCU fixture above if needed, the official agent CLI, an already installed LCU prefix and signed desktop app, and the bounded task model proxy at `192.168.64.1:62098`. In the guest, run:

```sh
LCU_SOURCE_ROOT=/path/to/staged/source python3 /path/to/macos_harness_live.py \
  --agent hermes --cli /path/to/hermes --release /path/to/staged/source \
  --runtime /Users/lcuverify/lcu-installed/current/bin/lcu \
  --scope session --timeout 240 --evidence /private/tmp/hermes-session.json
```

Use `--agent omp` with its official CLI for OMP; use `--scope always` for the two-process check. The runner does not belong in the default container suite. It prepares only a separate development/test Node distribution for the Hermes source TUI, from the [official archive](https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.xz), verified against SHA-256 `6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe` in the [official checksum manifest](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt). It never acquires the OpenAI desktop app.

## Hermes always approval across fresh processes

Two independent Hermes processes reused generated app `dev.lcu.NativeFixture.f6201f432447450f876ba952bcd83a5e`, PID 9494. Process 9503 selected Always allow through the real TUI, producing exactly one `accept` with `persist: always`. Its three original `js` calls saved `lcu-hermes-99b7740a714e` and completed `Stop`. After that process was terminated, process 9577 made three original `js` calls, saved `lcu-hermes-e2b0104c7173`, and completed `Stop` with zero elicitation callbacks and no approval input. The agent session and turn IDs differed between phases. Both phases exercised the ready-composer startup fallback.

Private evidence is `/private/tmp/lcu-harness-full-20260928/hermes-macos-always-evidence.json`; queue job `bed0fe5b-4dbc-4974-8dab-7d7a4cce8466`. The runner SHA-256 for the Hermes session and always runs is `d6ca79db28616417291efd0fe92b47fddf65e9ec5591e92155925d16fa661336`, identical to the committed `tests/macos_harness_live.py`. The host proxy recorded 33 successful model requests across all four native checks, with no credential copied into the guest.

Hermes and OMP forward the requested persistence scope to the original runtime; LCU owns no persistent grant cache. Both checks prove always-grant reuse across replacement of the agent and MCP processes for the same app. Neither establishes persistence across VM reboot, deliberate native-helper restart, app update, or revocation. The browser and clean-source container evidence remain separate from this native overlay check.
