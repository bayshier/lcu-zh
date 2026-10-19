# Original user-verification transport audit

Scope: the pinned 26.915.31945 original application extracted at `/private/tmp/lcu-host-review/extracted/.vite/build/`. This is a source audit only; it does not exercise the desktop or CLI.

## Linux reachability

The original main bundle constructs the app service as `userVerification: process.platform === "darwin" ? new vnt(...) : void 0` (in `main-DUHZj4_w.js`, UTF-8 character offset 3,421,235; the `begin` call is at 3,385,474). `vnt.begin({hostId, conversationId, requestId})` calls the selected connection's `userVerification.begin(conversationId, requestId)`. Thus the ordinary Linux app-service registry does not expose a caller for this flow.

The shared original connection in `src-C3YaUE83.js` does contain the feature. Its `userVerification.isAvailable()` checks local host, stdio transport, initialized connection, and lifetime; it has no platform check. `observeRequest` records only `mcpServer/elicitation/request` requests whose mode is `openai/userVerification`. However, source search of the extracted original bundles finds no other consumer of `userVerification.begin` or `userVerification/` outside this implementation and the Darwin-gated app service. In particular, the browser `AuthTokenCache` adapter does not call this API. This makes the current `auth.cjs` response throw unreachable through the normal Linux application surface; it is not, by itself, evidence of a Linux user-facing blocker.

## Provider boundary

The shared JavaScript declares the result categories `credentialMissing`, `biometricsUnavailable`, and `providerUnavailable`, and sends `userVerification/status`, `userVerification/enroll`, `userVerification/verify`, and `userVerification/cancel` requests to the app-server. The proof response is `{id, result:{action:"accept", content:proof, _meta:null}}`. The actual credential and biometric provider is behind those app-server RPCs; it is not implemented in the extracted JavaScript. The independently extracted Debian `resources/codex` is an ELF 64-bit ARM aarch64 statically linked, stripped Linux executable. Its architecture is not evidence of provider availability. This JavaScript source audit does not establish which native verification provider the Linux CLI implements or whether it can satisfy those RPCs. Do not activate the Darwin-only app service on Linux based on this audit.

## Generic RPC seam

The parent stdio client has a general transport limitation independent of Linux user verification: `lcu/app_server.py` rejects every incoming JSON-RPC message containing both `id` and `method` as an unexpected host request, and `lcu/host_bridge.py` forwards notifications but has no request/reply leg. The original connection's message ingestion routes server requests and its `handleClientResponse` sends the matching `{id, result|error}` response through its message delivery. If broader original app-server parity requires server-originated requests, the smallest applicable seam is a correlated generic request callback over the existing parent stdio stream, followed by response delivery through that original connection API. Keep such transport work separate from exposing native user verification on Linux.

## Provenance

SHA-256 of extracted bundles:

- `main-DUHZj4_w.js`: `9e8a3bd79c817064f28693ca26aa1378895e07ab2108c78c42d0ea20dac9d66e`
- `src-C3YaUE83.js`: `14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472`
- `bootstrap-DF0QwAxC.js`: `5787d416ccbd7be549251d2c691f9c2579d6960f3ccd470037d97486c93fdf0f`

## Subsequent standalone transport change

The audit above describes the inspected pre-change adapter. LCU subsequently added the optional `AppServer(request_handler=...)` seam for generic incoming requests. It retains the original request ID, requires a result/error response from the caller, and returns an explicit unsupported error when no handler is connected. It does not expose the Darwin-only verification service or supply approval policy. Subprocess regressions cover caller responses while browser polling preserves pending RPC replies and notification delivery.
