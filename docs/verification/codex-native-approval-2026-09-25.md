# Codex CLI native-app approval response probe

On 2026-09-25, the pinned macOS app-bundled Codex CLI `0.155.0-alpha.16.3` rendered the original Mac CUA native-app approval and returned each advertised scope through MCP elicitation. The probe used no account, API key, paid model, real app operation, or personal data. A local scripted Responses endpoint invoked an official MCP SDK 1.30.0 service; each run used a fresh temporary `HOME`, `CODEX_HOME`, project, and synthetic app bundle ID.

The SDK fixture reproduces the native Mac request shape at `params._meta`: `codex_approval_kind: "mcp_tool_call"`, `connector_id: "computer-use"`, `connector_name: "Computer Use"`, `persist: ["session", "always"]`, risk level, `tool_name: "get_app_state"`, synthetic app bundle ID, display name, and synthetic `x-codex-turn-metadata`. It uses an empty form schema and the original “Allow Computer Use to use …?” message. This probe covers the native Mac request shape; it does not test the separate desktop/browser `params.meta` path.

| Codex TUI choice | Observed MCP response |
| --- | --- |
| Allow | `{"action":"accept","content":{}}` |
| Allow for this session | `{"_meta":{"persist":"session"},"action":"accept","content":{}}` |
| Always allow | `{"_meta":{"persist":"always"},"action":"accept","content":{}}` |

The test harness also checks that the request is the expected native approval form and records one raw SDK request and response. Its success response explicitly says that no app operation ran. The harness does not issue a second request to test Codex CLI grant reuse, and this evidence does not establish a Codex-owned grant cache. The original runtime's session-grant reuse is covered separately in [native app approval scopes](native-app-approval-scopes-2026-09-25.md); the original runtime remains the authority for its approval state.

Re-run from a terminal with the target CLI path:

```sh
npm ci --prefix adapters --ignore-scripts
python3 tests/codex_native_approval.py --cli /absolute/path/to/codex
```

Choose one scope in the TUI, wait for “Fixture complete,” then press Ctrl+C to exit. Each invocation creates a fresh isolated home and prints the temporary directory containing `approval-events.jsonl`. Repeat the command for the other choices. The test server binds only to loopback and the Codex CLI configuration disables authentication for its local scripted provider.

The inspected executable was `/private/tmp/lcu-mac-guest-staging-20260924/ChatGPT.app/Contents/Resources/codex`. The official Codex [`rust-v0.155.0-alpha.16` TUI elicitation source](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.16/codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs) conditions the session and always options on the request's `persist` metadata and creates the corresponding one-shot/session/always choices. The [matching core MCP session source](https://github.com/openai/codex/blob/rust-v0.155.0-alpha.16/codex-rs/core/src/session/mcp.rs) routes elicitation through the active thread and turn. These sources corroborate the behavior; the installed CLI UI and SDK response logs are the tested evidence.
