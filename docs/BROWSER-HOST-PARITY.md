# Browser host integration and remaining parity work

> Historical audit of the unpublished embedded-browser candidate. The current LCU release scope uses the original external Chrome provider; see [installation](INSTALLATION.md) and [status](PARITY-STATUS.md).

The complete runtime includes the original browser code and instructions. Loading
that code is not proof that every browser backend can perform tasks. The native
Linux desktop and the browser provider use different host services.

This audit targets official package `26.915.31945`, embedded runtime
`0.0.16/20260915001755-492f19756c31`. Source paths below are relative to
`usr/lib/chatgpt/resources` in the checksum-pinned [ARM64 package](https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.915.31945_arm64.deb)
and [x86-64 package](https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.915.31945_amd64.deb).

## What the launcher preserves

LCU executes the original
`cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs`. It enables `browser,computer`
by default. Callers can still set `CUA_REPL_ENABLED_SURFACES` and
`CUA_REPL_BROWSER_ENV` to any upstream-supported choice (`codex-app`, `training`,
`cloud`, or `orbit`). The original launcher chooses the trusted browser and Sky
services and their instructions.

LCU retains caller configuration, including `OAI_SKY_CONFIG_PATH`,
`OAI_SKY_LINUX_BIN`, `NODE_REPL_TRUSTED_SERVICES`, `NODE_REPL_JS_BANNER`, sandbox,
approval, model-check, browser-policy, request-metadata, and additional module/trust
roots. Its defaults select the bundled original Node, REPL and Codex CLI. No
browser security checks are disabled by default.

## External Chromium browsers

The official package ships an independent native messaging host in
`plugins/openai-bundled/plugins/chrome/extension-host/linux/<arch>/extension-host`.
It also ships `scripts/installManifest.mjs`, the browser client/service, diagnostic
scripts, and extension identifiers. These are retained under `host/plugins/chrome`.

Run this as the Linux account that owns the browser:

```sh
lcu browser install
```

The command copies the original Chrome plugin into the account's writable XDG
data directory and invokes the original `installManifest.mjs` export. The upstream
installer writes its native-host configuration beside the host executable and
registers `com.openai.codexextension` for the supported browser profile locations.
The sealed release is not modified. Running this command repoints that native-host
registration to this LCU installation. It does not install a browser or extension.

The original installer supplies manifests for Chrome/Chromium, Edge, Brave, Opera
and Vivaldi. Install or enable the official ChatGPT browser extension in the chosen
browser. The executable host, extension and MCP service must run as the same
account. A custom `--user-data-dir` outside the upstream installer's supported
locations needs its native-host manifest placed there by the browser administrator.

The native host needs `codexCliPath`, `nodePath`, `nodeReplPath` and
`browserClientPath`. LCU supplies these to the unchanged installer. They are
ordinary local executable paths, not tokens or credentials.

## Session identity and turn completion

`@oai/browser-desktop/scripts/browser-service.mjs` reads
`requestMeta["x-codex-turn-metadata"]` (`qe`), requires string `session_id` and
`turn_id` (`IH`/`Sk`), then discovers sockets under `/tmp/codex-browser-use`
(`Ta`, `GB`, `qZ`/`jZ`). A normal Chrome debugging port is not this protocol.

The original REPL accepts default request metadata through `NODE_REPL_REQUEST_META`
and per-call MCP `_meta`. When no default is supplied, LCU creates a real local
connection UUID and a connection work-session identifier. It supplies only these
two routing identifiers. It does not invent a model name, approval, user account,
or Codex session. Explicit host metadata remains authoritative.

For the original per-turn behavior, the agent host must supply its real session
and turn IDs on each call and invoke the original `turn_ended` tool at Stop,
Interrupt, or SubagentStop. The browser runtime's `vf` tracker registers
`addTurnEndedHandler`, tracks the backend session/turn pair, and sends the cleanup
callback on matching completion. `dispose()` unregisters the callback and clears
tracking; that is not evidence that closing stdio reproduces a completed agent
turn. Generic clients using only the connection fallback therefore do not yet have
verified per-agent-turn lifecycle parity.

## Authentication and default browser actions

The original external-browser provider is discoverable without a Codex login.
In the isolated test, creating a tab with the default upstream policy fails with
`Codex auth token is unavailable`, identically in upstream and LCU.

The source path is concrete: the identity fetch in `browser-service.mjs` requests
`https://chatgpt.com/backend-api/aura/identity` through trusted `nodeRepl.fetch`.
`Gw` retains its promise and the request-header decision awaits it. The service
reads the user-specific `codex_browser_use_agent_request_header` Statsig gate
when a fresh extension reports `agentRequestHeaderEnabled: false`. An extension
already reporting `true` skips the lookup on that path. When
the gate enables the header, the official extension sets
`x-browser-agent: ChatGPT/<session ID>` on requests from agent-controlled tabs.
This is a website-visible traffic label, not a login credential or signed proof.
Agent-traffic labeling and controlled rollout are inferred purposes; the pinned
code does not document OpenAI's reason for the feature.
The native REPL obtains authentication through `CODEX_CLI_PATH`, starting
`codex app-server` and using `getAuthStatus`. This path is not an Electron-only
socket. The tests contain no user credentials and have no network; they do not
establish successful authenticated browser operations or backend access for an
arbitrary agent account.

`BROWSER_USE_SECURITY_MODE=disabled-for-local-testing` is an upstream test option,
not an LCU default or a substitute for production parity. It bypasses selected
security checks. It does not remove the separate identity dependency. Likewise,
`BROWSER_USE_DISABLE_AMBIENT_NETWORK` is not an authentication replacement.

## IAB, CDP, cloud and Orbit

| Surface | Original dependency | Current evidence |
| --- | --- | --- |
| External Chromium extension | Original extension, Linux native messaging host, real session metadata, applicable auth/policy services | Real offline discovery demonstrated; default action blocked by missing test credentials |
| In-app browser (`iab`) | Original Owl/Electron shell, original IAB host and exact session ownership | Original full host and original renderer passed the checked-in ARM64 provider test; both-architecture packaged and authenticated-client tests remain |
| CDP backend | A provider speaking the upstream native-pipe browser-backend protocol | Client retained; a raw Chromium CDP endpoint is insufficient; standalone upstream server not identified in this package |
| `training`, `cloud`, `orbit` | Original environment-specific APIs/docs plus their provider, session, policy and authentication services | All modes retained; documentation/bootstrap selection is not backend task-success evidence |

IAB implementation lives outside `cua_node`, in `app.asar`'s
`.vite/build/main-DUHZj4_w.js`. Its `getInfo` returns an IAB descriptor bound to a
Codex session. `executeCdpForBrowserUse`/`sendDebuggerCommand` use Electron
`webContents.debugger`, application browser sessions, route ownership and tab
managers. The browser client filters IAB providers to the current session and
build flavor (`PZ`/`IZ`). Reusing those client files does not instantiate this host.

The browser service also retains the cloud credential-broker integration. In
`gaas-browser-environment` mode it loads `BROWSER_USE_CONFIG_PATH` (default
`/home/oai/.config/gaas-browser/config.json`). The credential-binding path checks
`BROWSER_AUTH_BROKER_CREDENTIAL_BINDING_VERSION`,
`ENABLE_BROWSER_SESSION_TAB_OWNERSHIP` and the expected
`/run/codex-browser-auth/browser-auth-broker.sock` before operating. These services
are external host requirements; LCU does not replace them with an invented backend. The package metadata names `@oai/cdp-browser-backend`, but the complete Debian file inventory contains no physical package, archive, or executable providing that server. `CDP_BROWSER_BACKEND_PIPE_PATH` filters a discovered socket in the corresponding test mode; it does not turn a Chromium debugging socket into the native-pipe service.

## Reproduction and interpretation

Build an ordinary complete LCU archive and the verification base image first.
Then run:

```sh
bash tests/browser-run.sh linux/arm64 /absolute/lcu-bundle.tar.gz /absolute/upstream/usr/lib/chatgpt/resources
```

The image build uses the bundled Playwright's pinned Chromium revision 1200
(`143.0.7499.4`) and a checksum-pinned official ChatGPT extension
(`1.26.901.11451`, SHA-256
`688d5c0a8141c9bee394d3738d4a177b448713c2fa9c29b5af1815bfddae46e1`). The Google update
endpoint is mutable, so a changed artifact fails closed and requires a reviewed pin
update. The fixture restores the original CRX public key in the unpacked manifest
to preserve the extension ID; executable extension files remain unchanged.

The actual test container has `--network none`, a new profile and no credentials.
It invokes the original installer, runs the original extension/native host,
compares original/LCU browser discovery and the authentication boundary, and
checks generic connection identity plus host metadata override. A matching auth
failure is reported as a blocker, never as a successful browser action. Successful
authenticated actions, all browser families, cloud/Orbit providers, the final standalone IAB integration and
per-turn lifecycle parity remain required work.

## Standalone IAB host derivation

The original package contains a usable host implementation, not only a client.
The standalone host now reuses the complete original `zZe` browser host and `uX`
session registry, including `fYe` automation, `NYe` native transport, `Soe`
navigation restrictions, `SGe` download authorization, `wWe` browser-session
configuration, persistence and webview lifecycle. `Pt` in the original bootstrap
module supplies the application network policy. The original full application
remains unchanged under `host/application`; its Owl shell is required because
upstream explicitly rejects stock Electron.

`scripts/extract_iab_host.cjs` reads three checksum-pinned modules directly from the
original `app.asar`. It emits original declaration bodies and initializers, retains
their original relative module resolution, and exports their classes for local
host integration. `derivation.json` records every selected byte span and SHA-256.
The original bootstrap import is redirected to extracted bootstrap declarations
because importing the complete bootstrap also launches the entire Codex app.
No provider methods are rewritten. The complete originals remain bundled for
comparison and for all imported modules.

`lcu/host` supplies a local owner window and mounts webviews through the original
renderer-generation registration and attachment checks. It does not implement
browser automation. The new shell connects original renderer exports `NSe` (`app-shared-81f4259020b8.js`) and `L` (`button-3b7641138a7c.js`) to local window ownership. The original classes handle webview painting, viewport/capture sizes, cursor animation and arrival, disposal and release. LCU handles service wiring, window presentation, and teardown acknowledgments. These presentation
adapters are LCU code and must be tested; their existence is not evidence of
byte-identical behavior with the Codex app renderer. Original app-specific panels,
annotation composer UI, shortcut state and Codex deep-link handling are not proven
by the browser-provider tests.

The Python bridge obtains real `configRequirements/read` replies from the bundled
Codex app-server and passes them into unchanged `Pt.refreshRequirements`. Account
updates refresh the policy; disconnect invalidates it. No unrestricted policy is
invented. The original `Pt` rejects restricted application networking as unsupported
by this pinned shell. Incoming session registrations bind an actual caller ID to
an actual local owner window. Unknown sessions are rejected by `uX`; the helper
does not claim all discovered session IDs.

The helper uses JSONL on stdin for `requirements`, `invalidate`, `session`,
`turn-ended`, `features`, private `app-server-response`, notifications, and `shutdown`. Session registration emits `lcuHost: "session"` with
the actual session ID and original native-pipe path. Host EOF destroys only its
owned windows and original backends. The normal original `turn_ended` MCP hook
remains responsible for per-turn browser disposition; host shutdown is a separate
process-lifetime boundary.

A disposable ARM64 prototype exercised the original full `zZe` host and renderer
attachment path successfully: `getInfo`, `createTab`, `Runtime.evaluate`, hidden
`Page.captureScreenshot`, `getTabs`, and `turnEnded` closing a temporary tab.
That prototype used the original shell in an offline container. It did not use a
login, and it called the lower-level provider directly; it is not evidence that the
authenticated browser client completed those actions.

The checked-in `tests/iab_host.py` passed on ARM64 against the current host source,
original application and generated provider, including the image built from the
official package's declared system dependencies (`lcu-final-test:arm64`). The shell
reported its actual profile path, which matched the dedicated fixture profile. It covers real CLI requirements,
unowned-session rejection, hidden localhost navigation, file-URL denial,
viewport/visibility, cursor arrival, screenshot, additional session and turn cleanup.
It also navigates back using actual auxiliary mouse input, which exercises the
unchanged guest preload through its original runtime IPC dispatcher. This remains
a provider test; the authenticated browser client is not exercised. Exact packaged
candidate execution on both architectures remains a separate release check.

An earlier test reproduced a real missing-host dependency: the original
`browser-page-preload.js` calls synchronous annotation-policy IPC on a secure
main frame, including localhost. Original `oWe` registers this channel and `$Ue`
waits while `LZe.apiEnabled` is null. The real app hydrates this policy; the initial
standalone adapter did not, so navigation committed but the preload blocked and
`Runtime.evaluate` timed out. The adapter now calls the original
`setSiteAnnotationApiFeatureEnabled(false, true)` by default. A supplied host
feature policy can change these values through the same original setters. This
resolves the startup deadlock without inventing account policy. The original
`LBe` remote comment-mode service is now connected through original authenticated
workspace routing; its own error behavior is retained.

## Preload and renderer boundary inventory

The complete original `browser-page-preload.js` references five IPC channels.
These are independent of the local shell's `lcu-iab:*` bridge.

| Channel | Original owner | Standalone behavior |
| --- | --- | --- |
| `codex_desktop:message-for-view` | Original page runtime subscribes; `zZe` and its helpers emit | Original subscription and send paths retained unchanged |
| `codex_desktop:get-browser-annotation-api-policy` | `oWe` / `$Ue` / `LZe.getPolicy` | Original handler retained; safe startup defaults or supplied host values feed original setters |
| `codex_desktop:get-browser-webmcp-policy` | `oWe`, using `Cr()` and `IG()` | Original handler retained; original defaults or validated supplied host flags feed `Or` / `Dr` |
| `codex_desktop:browser-sidebar-runtime-message` | Original app initializer validates `GWe`, then its message dispatcher calls `zZe` | Original schema and all 17 permitted switch cases retained byte-for-byte, with original owner lookup; declaration extraction checks that schema and case inventories agree |
| `codex_desktop:browser-page-event` | Original app initializer validates `lte`, checks main-frame origin for `SZ` / `bZ`, then calls `zZe.handlePageEvent` | Same validator, frame checks and original host handler; only actually owned attached pages accepted |

The 17 runtime switch cases include editor/preview open and close, screenshot-ready,
anchor update, annotation permission/mode/suspension, modifier state, image drag,
and mouse navigation. Retaining them does not make missing annotation UI or
remote policy services operational. The build ledger records every original case's
source byte span and SHA-256; no automation method is rewritten.

The local renderer handles the webview lifecycle messages used by the original
`page-4567b1248b7c.js` detached-page controller: browser-use activity/release,
viewport, capture surface, tab capture, destroy and cursor state. It mounts the
same original webview/cursor classes. The original permission prompt and annotation
composer have ARM64 native-input evidence. The full original browser panel is
being connected to its surrounding contexts and command services. Opening a
browser page alone does not prove that complete human browser interface.

## Remaining host integrations, with consequences

These are incomplete local adapters, not reasons to exclude original code. The
full application, original services and renderer files remain bundled unchanged.

| Original service / call site | Current adapter | Missing behavior / requirement |
| --- | --- | --- |
| Real app `LBe({appServerClient})`, backed by original authenticated `aT` fetch to `/aura/site_status` | Original service connected to original `HB` account/workspace routing and original token cache | Local wiring exists; successful authenticated service access remains untested. Original `LBe` logs and returns its own fallback on service failure. |
| Real app `HXe(appServerClient)` site bootstrap | Original callback connected through `HB` / `aT` | Requires real authenticated account/workspace routing and the actual `autoAuthForSites` feature value; successful site login remains untested. |
| Real app `Dr(Or(...))` feature hydration, host `setSiteAnnotationApiFeatureEnabled` and related setters | Original defaults or caller-supplied validated host feature policy | The standalone helper does not fetch the real app's resolved account/rollout flags automatically. Supplied values are configuration, not proof of managed approval. |
| `windowManager.getAppShellShortcutState` used by `fZ`, `_U`, `vU` and `zZe.closeFocusedVisibleBrowserTab` | Owner WebContents state from original app-shell messages and the actual visible browser route; original menu accelerators and command handlers | Six native browser command cases passed ARM64, including the original Find surface and owner-window Close shortcut. Final archive and x86-64 verification remain. |
| `windowManager.queueCodexDeepLinkUrl` used by `fZ` connector/OAuth/deep-link handling | Original per-owner `dk` queue and mounted `pul` / `bul` OAuth hooks; explicit session-bound library and opt-in Linux desktop-handler delivery | Queue acceptance and offline error paths are tested. Authenticated completion and ambiguous multi-owner in-page callbacks remain unresolved. See [shell integration](BROWSER-SHELL-PARITY.md). |
| Popup-created events consumed by `eGe` / `NWe` | Local owned popup factory connects original editor/popup lifecycle | ARM64 native typing and Comment submission produced independent saved body/anchor and guest marker outcomes. Final packaged gates remain. |
| `settingsStore`, `getCommandKeymapState`, `getDownloadDirectory`, `getPromptForUserDownloads`, `isDefaultBrowser` | Original `vD` / `OD` settings, keymap and download preference adapters; current OS default-browser check | ARM64 private configuration persisted through the original CLI and reopened correctly. Final packaged gates and additional settings behaviors remain unverified. Personal settings are never copied into test fixtures. |
| `onAppEntrySource` | Absent optional callback | Original app-entry attribution is not forwarded; no effect claimed for automation correctness. |
| Original `lZe` app-server notifications | Owned helper CLI notification stream | `item/completed`, thread archive/idle handling exists, but an unrelated parent agent's app-server event stream is not automatically the helper CLI's stream. Actual parent lifecycle metadata/hooks remain required. |

The sixth `zZe` constructor parameter uses original `_He()` viewport selection,
including `CODEX_BROWSER_USE_DEFAULT_VIEWPORT_SIZE`. The third host ID defaults to
the original local-host value; owned-window lookup also returns that value. Those
are original default paths, not replacement implementations. Optional error/app
entry callbacks do not establish application-level parity.

## Profile and session lifecycle

The host starts the unchanged shell with a dedicated `--user-data-dir` before
JavaScript runs. The Python bridge chooses
`$XDG_DATA_HOME/lcu/browser-profiles/<sha256(initial-session-id)>`, or the explicit
absolute `LCU_BROWSER_PROFILE`. A caller must not share one profile between
simultaneous host processes. Persistent real session IDs preserve the profile
across reconnects; generic connection UUID fallback creates a new profile per
connection and therefore does not preserve browser storage across reconnects.

Each registered session owns an actual window and an original `uX` route. A
window's original cleanup runs before removing its owner mapping; then the helper
emits `lcuHost: "session-closed"`. The Python bridge drops the cached routing entry
so subsequent use can register that session again. Host metadata must follow the
upstream subagent rule as well: subagent requests use the actual child thread ID.
Automatic wildcard claiming of session IDs is not permitted.

## Original authenticated services

`src-C3YaUE83.js` contains `HB`, which discovers workspace routing using real
`account/read` and `configRequirements/read` replies and validates the token's
account against that route. LCU retains this class and 27 original `D$` auth-cache
members without changing their bodies. Original expiry checks, refresh promises,
generation checks, account/principal invalidation and AbortSignals remain active.
The original shared module is initialized first so its global setup is preserved.
The derivation ledger records each selected member and source byte hash.

`lcu/host/auth.cjs` supplies only a connection/transport adapter. Requests pass to
the owned original CLI through `lcuHost: "app-server-request"`; responses return
only through the private child stdin. Tokens are never included in host reports
or test evidence. The bridge accepts the original read methods `getAuthStatus`,
`account/read` and `configRequirements/read`, distinguishes remote RPC errors from
transport loss, and invalidates on disconnect. Account updates/login completion
clear the original cache. The shared parent RPC adapter can delegate incoming
requests to an explicit caller-owned handler, or returns an unsupported error.
The original native verification app service is Darwin-gated; see the
[reachability audit](verification/user-verification-transport-audit.md). LCU does
not manufacture approval decisions.

Original `LBe` and `HXe` call original bootstrap `aT`, retaining its workspace URL,
account-routing headers, auth refresh on 401, redirect policy and abort checks.
No token is translated into guessed legacy routing. The pinned CLI's version is
outside the original legacy compatibility interval, so missing workspace routing
remains an original error. Original `LBe` has its own logged failure fallback and
`HXe` returns no bootstrap token on failure; LCU does not claim those outcomes as
a successful authenticated operation.

`tests/iab_auth.cjs` with `tests/iab_auth.sh RELEASE_ROOT` exercises the original
cache against an isolated synthetic transport: missing-account caching, explicit
RPC error, account-change abort/cache reset, and disconnect rejection pass on
ARM64. `tests/iab_host.py` separately uses the actual unauthenticated CLI. Neither
test proves valid-account remote access or account switching with live credentials.

## Supplied feature policy

A trusted host may set `LCU_BROWSER_FEATURES_PATH` to a JSON file:

```json
{
  "desktop": {"inAppBrowserUseHistory": true, "webMcp": true, "webMcpMaxTools": 100},
  "annotationApi": {"enabled": false, "permissionRequired": true},
  "tweaks": false,
  "annotationMultiSelect": false
}
```

The same object can be sent in `{"type":"features","policy":...}` for live
updates. `desktop` passes the original strict partial schema `Nte`, then unchanged
`Or` normalization for the production Linux shell and `Dr` state hydration.
Omitted desktop fields retain their original defaults. Annotation, permission,
tweaks and multi-select values pass the original `zZe` setters. Omitted annotation
values start disabled with permission required, avoiding a pending synchronous
preload request. The provider test verifies supplied history support and WebMCP
limits through original code, then restores defaults.

These are host feature values, not authentication credentials, managed network
requirements or user approval. Matching an actual Codex app requires that host's
resolved values. Annotation editor UI, its permission prompt rendering, app-shell
shortcuts and other missing adapters listed above still need integration even
when the corresponding feature is enabled.
