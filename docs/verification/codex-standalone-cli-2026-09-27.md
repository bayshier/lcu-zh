# Public standalone Codex CLI verification, 2026-09-27

The Codex host under test was the public standalone [@openai/codex package](https://www.npmjs.com/package/@openai/codex), version `0.157.1`; the executable reported `codex-cli 0.157.1`. The npm `latest` dist-tag and [official GitHub release](https://github.com/openai/codex/releases/tag/rust-v0.157.1) both resolved to `0.157.1` on the test date. The official [Codex hooks guide](https://learn.chatgpt.com/docs/hooks) documents `mcp_tool` handlers on already-connected MCP servers and the `Stop`, `Interrupt`, and `SubagentStop` events used by LCU. No LCU-generated lifecycle protocol was needed.

## Deterministic parser reproduction

An empty temporary `HOME` and `CODEX_HOME` containing the original `Stop` hook (`type = "mcp_tool"`, server `lcu`, tool `turn_ended`, input fields `session_id` and `turn_id`) reproduced the failure in the locally installed public CLI `codex-cli 0.145.0`:

```text
Error: failed to load configuration
unknown variant `mcp_tool`, expected one of `command`, `prompt`, `agent`
```

The same config passed `codex mcp list` with exit status 0 in the public `0.157.1` CLI. Both probes used a fresh home, no account configuration, and no model call. `lcu setup` therefore reports the executable and version that failed, and directs the user to update the standalone CLI before registering its original hooks.

## Original tool and cleanup contract

The real public `0.157.1` CLI passed all four original MCP result cases against a scripted provider bound to loopback. No account credential, real model, browser, or user session was used. The fixture set `requires_openai_auth = false` and sent only local provider requests.

| Case | Public CLI result |
| --- | --- |
| Text | Exact original text reached the provider. |
| PNG | MIME type and bytes were unchanged; both original and provider SHA-256 were `036db0272ba76df7711c9cf4257808effcb0fc3c9e02f9e5d0007060cd497ed5`. |
| WAV | The relay saved exact bytes at an absolute local path with SHA-256 `9d3f06e364a9665a7cd302327f3a84799952d7def702d590a2cdbecd71bab515`; the provider received a MIME-tagged path reference, not WAV bytes. |
| MCP error | Original error text reached the provider and Codex marked the host tool event `failed`. |

For each case, the public CLI loaded the original initialization instructions and public `js`/`js_reset` tool descriptors, executed one `js` call, then called hidden `turn_ended` through the relay. The captured cleanup input had `hook_event_name: "Stop"` and the same real `session_id` and `turn_id` supplied on that turn. The provider saw only `js` and `js_reset`; the source policy still enabled `turn_ended` for host lifecycle use.

The harness now accepts `--cli` for the standalone CLI and `--app-resources` for the original plugin metadata as separate paths. This run used the app resource directory only to load the original MCP policy and hook manifest. It did not use the app's Codex executable as the host under test. The exact command was:

```sh
python3 -B tests/result_codex_cli.py \
  --cli /private/tmp/lcu-public-cli-probe/@openai/codex-0.157.1/node_modules/.bin/codex \
  --app-resources /Applications/ChatGPT.app/Contents/Resources \
  --node /Users/polarzero/.nvm/versions/node/v24.11.1/bin/node \
  --version 'codex-cli 0.157.1' \
  --output /private/tmp/lcu-result-codex-public-0.157.1-20260927-rerun
```

Result: 4/4 cases passed on macOS 26.5 (build 25F71), arm64. The complete local summary and request captures are under `/private/tmp/lcu-result-codex-public-0.157.1-20260927-rerun/`. This verifies the cited public CLI version and the tested result and Stop-hook paths; it does not claim every release, operating system, or real-model response.
