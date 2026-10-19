# Harness contract audit

Updated 2026-09-26. LCU should preserve the original CUA runtime as the policy and execution authority. Harness adapters should provide only transport, host identity, user-facing elicitation, and lifecycle wiring.

| Contract area | Verified boundary |
| --- | --- |
| Public tools | Keep original `js` and `js_reset` descriptions, schemas, and initialization instructions. Hide only host-internal tools such as turn-context and cleanup hooks. |
| Identity and cleanup | Bind calls to real host session and turn IDs. Dispatch matching original cleanup only for lifecycle events the host reports. Do not invent idle-wait cancellation or permission state. |
| Elicitation | Return the user's actual accept, decline, cancel, and supported form response. Native-app persistence choices are the scopes in the original request; the original runtime applies them. Browser-origin approval is separate. |
| Computer and browser behavior | Leave screenshots, accessibility, input, OS privacy, browser extension, and site policy to the pinned original runtime and platform helper. An exact-origin allowlist is explicit user authorization, not a general network grant. |
| Result forwarding | Compare the same text, PNG, WAV, and `isError` MCP fixtures across all three maintained harnesses. The matrix records host status and provider-visible input; it cannot prove universal model or UI presentation. See [adapter results](../ADAPTERS.md#same-case-result-forwarding). |

The supported native-app and external Chrome paths have not produced generic schema-field or URL-mode approval requests. No such unobserved shape is a baseline parity requirement. The actual tests, not hypothetical forms, determine the supported boundary.

## Primary sources and evidence

The installed pinned runtime supplies the CUA instructions, tool descriptors, and approval policy. The adapters use the official MCP SDK where a transport is needed. Host integration references include Pi's [versioned extension API](https://github.com/badlogic/pi-mono/blob/v0.73.0/packages/coding-agent/docs/extensions.md), Claude's [MCP elicitation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests) and [hook reference](https://code.claude.com/docs/en/hooks), and the [MCP elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).

Historical task evidence remains scoped to its source and method: [Pi GTK and Chrome](pi-generated-gtk-real-model-2026-09-24.md), [Codex CLI](codex-interactive-2026-09-24.md), [Claude relay lifecycle](claude-relay-2026-09-25.md), [native approval scopes](native-app-approval-scopes-2026-09-25.md), [pinned input restoration](runtime-input-restoration-2026-09-26.md), and the [same-case harness results](harness-results-2026-09-26.md).
