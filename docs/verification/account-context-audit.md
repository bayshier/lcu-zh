# Account context audit: 2026-09-22

Baseline: pinned package `26.915.31945`, original
`app-initial-430deae5a13a.js` from its `app.asar`. This records the source finding
that triggered restoration; it is not evidence of a successful authenticated run.
Source SHA-256: `882fff7cf1759f29e02d25aa896eb45ad9cb731d4a1257a474ea3aeebeef758f`.

The original `wC(bp, …)` producer (UTF-8 byte 3293868) is used by the full `GYc`
auth provider (byte 11197021). It obtains Copilot API availability through `rHn`
and the original `is-copilot-api-available` host service, and the loaded
`use-copilot-auth-if-available` global-state query. Its `uHn` path obtains
`getAuthMethod` and `getAccount`, then calls `hHn` with those actual values.
Auth-status updates can select `personalAccessToken`. `GYc` obtains ChatGPT
`computeResidency` from the `chatgpt-auth-token` query; other auth modes use null.

Correction after inspecting the original Linux host: the pinned
`main-DUHZj4_w.js` service is exactly
`"is-copilot-api-available":async()=>({available:!1})` at UTF-8 bytes
2041957–2042009 (SHA-256
`8e39600c44dc7bd4a8502079c92812bbd879ca015a75ea707d6e116eadf6d8c2`).
False is the actual original Linux capability result. The configuration input
still belongs in the producer path, but this Linux package cannot select Copilot
auth through that service. The earlier renderer-only observation overstated a
Copilot capability regression.

The earlier standalone renderer passed false for all three mapping options and
unconditionally set residency to null. The demonstrated differences on this
pinned Linux package are PAT selection and ChatGPT residency. `account/read`
plus an authenticated principal cannot reconstruct those values. The original
`getAuthMethod()` reads `getAuthStatus` without a token and `getAccount()` reads
`account/read`. The original `pT` account-info producer in `main-DUHZj4_w.js`
(UTF-8 bytes 1349637–1350856, SHA-256
`1032f3820785dccb0ed9853ee9ea0479576ff2b5c2b0211c8f1d97947019636a`)
calls `getAuthToken({refreshToken:false})`, extracts
`https://api.openai.com/auth.chatgpt_compute_residency` from the token claims,
and returns only account metadata. Token bytes must stay in the host.

The original absent-account fallback `pHn()` has null auth/email/plan and
`requiresAuth:true`. A successful account-read response instead honors
`requiresOpenaiAuth` when provided. False flags and null residency match only the
appropriate absent-capability/absent-token case; an unsigned-in account alone
does not establish that Copilot capability is unavailable.

`lcu/host/account-context.cjs` transports original account, auth-method,
global-state, capability, and account-info inputs without reproducing their
mapping in the host. The host extraction retains original `getAuthMethod`,
`getAccount`, `pT`, and the Linux capability service. Separate owned IPC reads
carry auth inputs and account metadata to the renderer; original `hHn`/`pHn`
perform account mapping there, with the field composition from `GYc`. The
fixture compares absent account, PAT, ChatGPT metadata, and failed
account/auth-status cases against those original producers. The original `pT`
fixture decodes a synthetic token and returns null metadata for a missing token.
These are source and fixture checks, pending the installed desktop gate.

This audit and fixture used local source only. No account, credential or
authenticated service was used. Authenticated positive-path testing remains
separate.
