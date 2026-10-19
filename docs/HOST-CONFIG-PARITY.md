# Original host configuration and LCU

> Historical audit of the unpublished full-copy/IAB candidate. Its path layout and IAB host descriptions do not describe the selected-app architecture. See [current adaptations](STANDALONE-ADAPTATIONS.md) and [status](PARITY-STATUS.md). The pinned upstream source analysis below remains evidence for the child-environment contract.

The original runtime and the original application's configuration are separate inputs. Retaining an environment variable supplied by a caller does not prove that LCU supplies the value the Codex application would have selected. This review separates restored fixed defaults, explicit standalone adaptations and host decisions that remain unresolved. The verification below is bounded to its stated coverage.

## Exact source

The source is the checksum-pinned Linux package `26.915.31945`; see [runtime.lock.json](../runtime.lock.json). Both architecture inventories confirm identical application JavaScript sources. These original functions are indexed with hashes and exact source coordinates in [host-source-inventory.json](../scripts/host-source-inventory.json):

| Source inside `app.asar` | Symbol | UTF-8 byte range `[start,end)` | Responsibility |
| --- | --- | --- | --- |
| `.vite/build/main-DUHZj4_w.js` | `So` | `153624–154678` | Select surfaces and browser backends from runtime paths and desktop feature availability |
| Same | `Lre` | `155157–155531` | Admit unified CUA only with Tinysky, compatible tool exposure, installed/enabled/available plugin and runtime paths |
| Same | `Ho` | `170370–171704` | Supply actual feature choices, optional account telemetry identity and platform-specific host paths |
| Same | `kie` | `171704–173985` | Assemble the Node REPL environment |
| Same | `Sne` | `97503–98573` | Fill the unified plugin's command, services, surfaces, backends and forwarded environment |
| `.vite/build/src-C3YaUE83.js` | `nne` | `396938–397703` | Set executable/module/trust paths, metadata, timeout and CLI access |

Main source SHA-256: `9e8a3bd79c817064f28693ca26aa1378895e07ab2108c78c42d0ea20dac9d66e`. Shared source SHA-256: `14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472`.

The actual archived `package.json` supplies `codexBuildFlavor: "prod"` and `version: "26.915.31945"`. Original bootstrap resolver `j` at byte `156656` in `.vite/build/bootstrap-DF0QwAxC.js` first accepts a valid `BUILD_FLAVOR` override, then package metadata, then a production/development fallback. A pinned package value is evidence; an arbitrary constant pretending to be a live feature or account value is not.

## Linux configuration matrix

“Caller-only” means the reviewed `lcu/runtime.py` preserves a value in its own process environment but supplies no value itself. This is an explicit standalone launch option; Codex's MCP child environment is a separate layer. The original app server starts with a copy of its process environment, but the pinned Codex CLI forwards only configured `env` and selected `env_vars` to an MCP child, as verified below. Original `nne` on Linux supplies a selected `env` map and an empty `env_vars` list.

| Input | Exact original host value or condition | Reviewed LCU behavior and consequence |
| --- | --- | --- |
| `NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS` | `nne` always writes the string `"1000"` | Restored: defaults to `"1000"`, retaining an explicit caller override. The real Unix-socket test below covers failure, recovery, delayed reads and malformed values. Actual timer expiration remains uncovered; matching the default input alone does not prove it. |
| `BROWSER_USE_TINYSKY_ENABLED` | `kie` always writes `"1"` or `"0"` from `browserUseTinysky`. `Lre` requires that feature to be true for unified CUA, so the admitted unified path writes `"1"`. | Restored to `"1"` for `codex-app`, retaining an explicit override. The real-provider configuration test checks effective `Tab.ax` versus `Tab.cua` / `Tab.dom_cua`, not only the environment. |
| `BROWSER_USE_CODEX_APP_BUILD_FLAVOR` | `kie` writes the result of original build-flavor resolution; pinned package default is `prod`. | Restored: a trimmed valid `BUILD_FLAVOR` from `dev`, `agent`, `nightly`, `internal-alpha`, `public-beta`, `prod`; otherwise pinned `prod`. An explicit `BROWSER_USE_CODEX_APP_BUILD_FLAVOR` wins. The IAB registry and original feature normalizer use the same effective client build flavor. A wrong-flavor client is tested against a real provider; matching alternate-flavor host behavior still needs an explicit execution. |
| `BROWSER_USE_CODEX_APP_VERSION` | `kie` writes its real `appVersion` input; this package is `26.915.31945`. This is **not** the `0.155.0-alpha.9.2` app-server version used by network/auth contracts. | Restored to `26.915.31945` for `codex-app`, preserving an explicit caller override. |
| `NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER`, `NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME` | `kie` adds unchanged `Eie` for selected `iab` and `Die` for selected `chrome`. `Oie` is guarded by `platform === "darwin"` and is not Linux guidance. | Restored verbatim for the selected codex-app backends. Actual delivery testing confirms they change bare `node_repl` tool descriptions; the unified launcher replaces that description, so its initialization, tool list and first-use text are identical with these two flags present or absent. |
| `NODE_REPL_ENFORCE_MODEL_CHECK` | `kie` writes `"1"` only when `desktopFeatureAvailability.nodeReplEnforceModelCheck` is true. `gr` starts this feature as false; live feature availability can change it. | Caller-only. Preservation is not a feature decision. Neither an unconditional `"1"` nor an invented model identity establishes parity. |
| `BROWSER_USE_AVAILABLE_BACKENDS` | `So` adds `chrome` when `externalBrowserUse` is true and `iab` when `inAppBrowserUse` is true; `kie`/`Sne` write the comma-joined selection, including an empty selection. This desktop path does not automatically add `cdp`. | Caller-only; the runtime's unset value imposes no backend selection. LCU's separate `--with-browser-host` validation default of `chrome,cdp,iab` is not an environment value or an original feature decision. Cloud/CDP provisioning is a different host contract. |
| `BROWSER_USE_DISABLE_AMBIENT_NETWORK` | Included in `kie`'s `wie` pass-through list; copied when present. No fixed restrictive value is fabricated. | Preserved when provided. This matches pass-through capability, not evidence that a managing host supplied a restriction. |
| `BROWSER_USE_DISABLE_API_MEMBERS`, `BROWSER_USE_DISABLE_BROWSER_CAPABILITIES`, `BROWSER_USE_DISABLE_TAB_CAPABILITIES` | Same `wie` rule. The browser runtime interprets these as comma-separated exclusion sets. | Preserved when provided. Empty/unset sets do not reproduce a nonempty host restriction. |
| `CODEX_CHROME_USER_DATA_DIR` | Remaining `wie` entry, copied when present | Preserved. There is no fixed original profile directory in these functions. |
| `BROWSER_USE_SECURITY_MODE`, `BROWSER_AUTH_BROKER_SOCKET_PATH`, `NODE_REPL_FORCE_STRICT_AUTO_REVIEW`, `NODE_REPL_JS_BANNER`, `NODE_REPL_TOOL_OVERRIDES` | Explicit `kie` process-environment copying is limited to `Dev`, through `Tie`. Absent security mode uses the original normal mode. | LCU preserves these when its own caller explicitly supplies them. Its standard Codex registration does not forward these keys from the app-server parent by default, so direct-launch preservation is not evidence of a production host mismatch. The unified launcher replaces tool overrides again, as described below. |
| `NODE_REPL_ENABLE_AUDIO`, `SKY_ENABLE_AUDIO` | `kie` supplies both `"1"` only if `computerUse` is true **and both incoming values are `"1"`** | Both are explicit standalone caller options and independently preserved. Standard Codex registration does not forward either from its parent by default. A Sky WAV test with only `SKY_ENABLE_AUDIO=1` does not prove the full original REPL audio-output contract. |
| `NODE_REPL_UNTRUSTED_ENV_ALLOWLIST` | `kie` copies a nonempty trimmed caller list. The original unified launcher appends `CUA_REPL_ENABLED_SURFACES` and `CUA_REPL_BROWSER_ENV`. | Caller value is retained; the same original launcher performs the append. Additional option tests must expose variables through the original mechanism when required. |
| `NODE_REPL_REQUEST_META` | `kie` supplies a process-environment default only in `Dev`; `nne` writes it only when supplied. Real production request metadata comes from the agent host. | LCU creates a connection UUID plus a connection-scoped turn identifier when absent. This is a documented standalone routing adaptation, not the original agent session/model/turn context. Real per-call metadata remains necessary. On Linux it also adds a default `codex/sandbox-state-meta` (`disabled` profile) unless the value already has one; see [Linux sandbox state](ADAPTERS.md#linux-sandbox-state). |
| `NODE_REPL_SENTRY_USER_ID`, `NODE_REPL_TRACE_META` | `Ho` supplies the cached authenticated user ID only when private-process context is included. Trace is `"1"` for internal builds or when the incoming trace flag is `"1"`. | Caller-only. Account-derived telemetry must not be invented. No account was accessed for this audit. |
| `NODE_REPL_DISABLE_ANALYTICS` | Explicitly forwarded through `Tie` only for `Dev`; these functions do not set it to `"1"` universally | LCU defaults it to `"1"`, retaining an explicit caller override. This is a standalone default, not the original production host default. |
| `CODEX_HOME`, `NODE_REPL_TRUSTED_CODE_PATHS` | `nne` always supplies the selected Codex home and a Linux colon-joined trust list containing that home and the selected module directories | Restored after explicit user approval: LCU supplies the selected `CODEX_HOME`, defaulting to `~/.codex`, and trusts that selected home. Explicit values stay unchanged; empty trust entries are omitted as in original `rne`. Bundled module/plugin roots and explicit caller trust roots remain standalone additions. The upstream test baseline derives its private fixture home independently. |
| `NODE_REPL_NODE_PATH`, `NODE_REPL_NODE_MODULE_DIRS`, `CODEX_CLI_PATH` | `nne` selects actual runtime paths and supplies the CLI on Linux when one was resolved | LCU selects its verified Node/module paths, retains additional caller module roots, and defaults the CLI to its bundled original CLI. These are concrete standalone path substitutions. |
| `CUA_REPL_NODE_REPL_PATH`, `CUA_REPL_ENABLED_SURFACES`, `NODE_REPL_TRUSTED_SERVICES` | `Sne` selects the original REPL, joins the admitted surfaces, and explicitly builds `browser: "@oai/browser-desktop/service"` / `sky: "@oai/sky/service"` only for those surfaces | LCU selects the same launcher, defaults surfaces to `browser,computer`, and relies on its original service-map default unless the caller overrides it. `So` only adds the unified `computer` surface when `platform === "darwin"`; LCU's Linux enablement is an intentional extension of the shipped runtime, not the pinned app's product selection. |
| `CUA_REPL_BROWSER_ENV` | Not set by `kie`/`nne`/`Sne`. The original instruction loader selects normal browser guidance unless `cloud` or `orbit` is requested. | LCU explicitly defaults to `codex-app`, preserves alternatives, and executes that original loader. |

The `wie` and `Tie` definitions are at main-source bytes `169979` and `170005`; their string constants are at bytes `49192–49394` and `87681–87882`. `gr` is at byte `64871`. These offsets identify original source, not newly invented configuration schemas.

## Effective API and tool exposure

The original browser service provides concrete consequences for missing values. Its SHA-256 is `fa354758746c6d4569a3d63474246ba64dcfb9a3f2572927218afa281cb281c3` at `cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`:

- `UZ`, byte `1677916`, honors explicit Tinysky `1/0`; otherwise it consults backend-specific feature gates. Enabling it supplies `Tab.ax` and disables `Tab.cua` and `Tab.dom_cua` overrides.
- `D0` / `Wh`, bytes `736882` / approximately `738330`, treat an absent backend variable as unrestricted; an explicit list restricts selection.
- `PZ` / `IZ`, bytes `1675011` / `1675191`, require the actual session match and additionally match IAB build flavor only when the client supplies one.
- `ww`, byte `1165750` vicinity, uses the supplied Codex app version in browser feature-policy context.
- `cu` / `I0` / `R0`, bytes `737036–737988`, apply API and capability exclusions; retaining their environment keys does not choose their contents.

The unchanged `@oai/cua-repl/.../launch.js` supplies the service map and banner only when absent, but **unconditionally constructs `NODE_REPL_TOOL_OVERRIDES`** from original instructions. A claim that an arbitrary caller tool override survives through this launcher would be incorrect.

The original unified plugin descriptor sets `enabled_tools = ["js", "js_reset", "turn_ended"]`, `omit_tools_from = ["code_mode", "deferred"]`, `startup_timeout_sec = 120`, and `tools.js.output_token_limit = 25000`. LCU copies that contract into Codex registration and portable exports. Actual Codex delivery tests verify the visible `js`/`js_reset` tools and output budget. Generic MCP clients do not automatically implement those Codex host fields; exporting the contract does not enforce it. Original Stop/Interrupt/SubagentStop hooks and real per-call identity remain separate lifecycle requirements.

## Findings and next checks

1. Fixed source-backed defaults are restored: unified codex-app Tinysky, pinned app version, validated build flavor, original use-case instruction strings and the 1000 ms connection timeout. Desktop choices do not silently apply to cloud/Orbit modes. Their semantic effect still requires the bounded tests below and eventual final-archive runs on both architectures.
2. Make the managing host's model-check and backend choices explicit. Preserve API/capability restrictions, but do not report a missing feature decision as fulfilled merely because the launcher accepts its variable. Do not fabricate account or model metadata.
3. `tests/differential_baseline.py` now derives fixed values independently from original `kie` / `nne` / `Lre`, including original trust roots in a private fixture. It never calls LCU's environment builder. Explicit alternate settings and Linux native enablement are identified as direct-runtime configurations beyond the original app's product selection. A common omitted flag no longer makes two reduced environments falsely agree. Real transport behavior is tested below; positive timer expiration remains uncovered.
4. Keep Linux native enablement, connection identity, analytics defaults, trust roots and generic-host tool policy identified as standalone adaptations or host responsibilities. The original app's paired audio admission is a host feature decision; direct use of the original runtime accepts explicit flags, and LCU preserves explicit standalone flags. No production audio mismatch follows from those two different launch paths alone.

This audit read only the pinned package, source inventories and local implementation. It accessed no credentials or accounts. Local extracted source excerpts and the empty-caller-environment snapshot are retained under `/private/tmp/lcu-host-config-audit`.

## Source-backed instruction and home details

`gM`, exported as `yi` from `.vite/build/src-C3YaUE83.js` at UTF-8 byte `532303`, resolves the Linux home as `process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")`; it does not trim or canonicalize the caller value. The WSL branches do not apply to Linux. Original `nne` adds that selected home and its module directories to the trust list. LCU now reproduces this selection and trust. Original `rne` omits empty roots before joining, while the child `CODEX_HOME` itself remains unchanged even when explicitly empty.

The unchanged original instruction strings in `kie` are:

- `Eie`: `Control the in-app browser in conjunction with the Browser Plugin.`
- `Die`: `Control the Chrome browser in conjunction with the Chrome Plugin. Prefer this method of controlling Chrome over alternatives (such as Computer Use) unless the user explicitly mentions an alternative.`

An offline ARM64 execution against the untouched original package captured all four combinations of bare/unified launcher and flags absent/present. Bare `node_repl` tool descriptions change and include the original guidance when provided. The unified launcher's initialization, tool descriptions and first-use instruction text match exactly after removing only execution duration. This is evidence of that launcher's original tool-override behavior, not evidence that upstream instructions may be condensed. Local raw evidence: `/private/tmp/lcu-config-test-evidence/use-case-delivery.json`.

## Remaining managing-host choices

LCU still does not reproduce the original live feature/account producer for model checks, backend selection, private telemetry, internal trace selection or feature availability. The supplied-feature interface must be connected to the managing host's actual policy. Preserving a variable already present in the LCU process is only transport. The original app's production/dev selection, paired audio admission, default telemetry decision and actual per-call metadata are host decisions, not demonstrated defects in direct standalone runtime execution. Generic MCP clients must implement or explicitly honor the exported visibility, output-limit and lifecycle contract; MCP registration alone cannot enforce host behavior.

## MCP child environment evidence

The pinned original `src-C3YaUE83.js` at byte `1046478` assembles the app-server process environment with `...process.env`. Its `nne` at byte `378167` supplies an explicit MCP `env` map and on Linux leaves `env_vars` empty. The original `kie` at byte `171704` puts the `Tie` keys in that map only in `Dev` and puts both audio flags in the map only after the `computerUse` and paired-flag check. Therefore the app-server parent can contain a key without the MCP child receiving it.

This was checked with the pinned ARM64 Codex CLI in the existing `lcu-final-test:arm64` image, with `--network none`, a temporary empty `CODEX_HOME`, a local scripted model, and a private read-only MCP tool. [host_env_forwarding.py](../tests/host_env_forwarding.py) (SHA-256 `aa8d3423a6fd7cad109c43d14ff2f7fed2d54974ea5da81ba2ccfb52029f9e19`) reproduces the two controls. Bind the extracted pinned `usr/lib/chatgpt/resources` directory to `/original` and this script to `/probe.py`, then invoke `/usr/bin/python3 /probe.py` and `/usr/bin/python3 /probe.py --with-env-vars` in that offline image. The default child received only the configured `env` value (`LCU_PROBE_CONFIG=present`); five other caller keys, including the two audio flags and strict-review flag, were absent. With `env_vars` listing a marker, `NODE_REPL_JS_BANNER`, and `NODE_REPL_ENABLE_AUDIO`, exactly those three additional values appeared. Unlisted `SKY_ENABLE_AUDIO` and strict-review stayed absent. Both commands exited zero. The same two controls also passed with the pinned x86-64 CLI under architecture emulation; log `/private/tmp/lcu-host-env-forwarding-x64.log` has SHA-256 `472bc60899bfbb3978553942add30772a528a8f4f8d894a4d4cca947d2802af5`. This demonstrates the pinned CLI's environment selection for this fixture, not every host or transport.

LCU's standard Codex registration supplies command and host tool policy but no `env_vars` list. Its `runtime.environment()` sees the selected child environment, so unconditional preservation there does not reintroduce variables filtered by the parent. A direct `lcu` caller can intentionally pass those variables; that standalone interface does not run the original Electron feature producer. Do not add a second filter in `runtime.environment()` based solely on `kie`'s explicit assembly.

The earlier CODEX_HOME trust expansion was rejected by automatic approval review, then explicitly authorized by the user. The restoration changes the runtime child environment; it does not edit a user's Codex configuration or copy credentials. Historical gate records retain the earlier unresolved status. The local IAB registry and original feature normalizer consume the effective build flavor.

## Effective browser configuration test

`tests/browser_runtime.py --iab-configurations RELEASE ORIGINAL_CUA_NODE OUTPUT.json` connects the untouched original browser client and the installed LCU entry point to the same real original IAB provider with an actual owned tab. The provider fixture creates that tab through its original native pipe; it does not insert credentials or alter authentication policy. Seven configurations check:

- the codex-app default exposes `Tab.ax` and hides `Tab.cua` / `Tab.dom_cua`;
- Tinysky disabled reverses those APIs;
- explicit API exclusions remove `Tab.playwright` and `Tab.clipboard`;
- explicit browser/tab capability exclusions remove `visibility` and `pageAssets`, preserve unrelated `viewport`, and reject acquisition of excluded capabilities;
- backend exclusion, a wrong build flavor and a foreign session prevent discovery of the owned IAB provider.

The disabled-Tinysky case also preserves an upstream failure: unified `cua.getTab` throws `Cannot read properties of undefined (reading 'get')`; original `browser.tabs.get` still returns the legacy API. A matching failure does not establish that this alternate configuration works end-to-end.

This test verifies effective APIs and rejection behavior. It does not prove all host integration, authenticated browser actions, model reliability, or parity against the entire original desktop application. The original provider code is shared by the two client runs, so host-port equivalence requires separate evidence.

On 2026-09-22 the seven cases, including rejected capability acquisition, passed on ARM64 against the untouched original client and the current development LCU entry point. Evidence: `/private/tmp/lcu-config-test-evidence/test-3.log` and `/private/tmp/lcu-config-test-evidence/result.json` (SHA-256 `caa76fa94da10890791561d8114d4de2dac91470ad1c4f5707efb850b9deb6fe`). This development fixture uses the original full application and extracted original provider; it predates final archive creation. The equivalent x86-64 and final-archive runs are not claimed by this result.

## Real native-pipe timeout scope

Original `browser-service.mjs` at UTF-8 byte `1666147` (`gf`) obtains `globalThis.nodeRepl.nativePipe`; `hf.create` at byte `1666260` calls its `createConnection`. The unchanged compiled `bin/node_repl` contains the embedded `createNativePipeBridge` implementation and Rust symbols `native_pipe_connect_timeout`, `connect_native_pipe`, and `tokio::time::timeout::Timeout<connect_native_pipe>`. The timeout environment key is consumed there; it is not a browser-service JavaScript timeout. The original browser discovery `NZ` separately calls `Wv(getInfo())`: `AZ = 5000` at byte `1674953`, with `Wv` at byte `1677478`. Another `KZ = 1000` budget applies to open-tab URL matching, not backend `getInfo`.

`tests/native_pipe.py RELEASE ORIGINAL_CUA_NODE OUTPUT.json` exercises the actual original bridge through a temporary trusted fixture service and an independent Python Unix-socket peer. It adds no production trust and implements no browser engine or transport. The source-backed default 1000 ms and explicit 100 ms settings both pass a successful connection/control, saturated-backlog rejection, same-process recovery, expected bytes received by the peer, and a response delayed approximately 350 ms after connection. The latter succeeds with a 100 ms connect budget, proving that this option does not impose a read/RPC deadline. A malformed timeout is rejected before the peer accepts any connection.

On Linux, saturating an AF_UNIX listener backlog causes immediate `Resource temporarily unavailable (os error 11)`, not a pending connect. Therefore this fixture **does not prove positive timeout expiration**. The suite reports that limitation explicitly. ARM64 original-versus-development-LCU execution passed all three configurations; x86-64 and final-archive execution must be performed separately. Evidence: `/private/tmp/lcu-config-test-evidence/native-pipe-2.log` and `/private/tmp/lcu-config-test-evidence/native-pipe.json`.
