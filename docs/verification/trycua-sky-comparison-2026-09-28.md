# trycua/Cua Driver and OpenAI Sky comparison, 2026-09-28

The closest comparison is Cua Driver versus the app-bundled Sky/CUA runtime.
The complete trycua/cua repository also supplies infrastructure outside that
comparison. This is source research, not a comparative desktop test.

## Findings

- **Scope:** trycua includes native desktop automation, cloud desktop fleets,
  local VMs through Lume, and evaluation tooling. Its native Cua Driver runs
  without requiring a VM. Sky/CUA supplies the desktop and browser control
  runtime reused by LCU; LCU does not supply a comparable fleet provisioner.
  [Cua project overview](https://github.com/trycua/cua),
  [LCU provenance](../PROVENANCE.md).
- **Distribution and integration:** Cua Driver's default implementation is MIT
  licensed and independently installable. It exposes CLI/MCP entry points and
  Python/TypeScript SDKs backed by a native Rust runtime. Optional perception
  components have separate licenses. LCU requires the installed official OpenAI
  app and reuses its runtime and instructions under their existing terms.
  LCU's MIT license does not relicense those dependencies.
  [Driver documentation](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md),
  [LCU provenance](../PROVENANCE.md), [LCU license boundary](../../README.md).
- **Control mechanisms overlap:** Cua Driver implements macOS accessibility,
  Windows UI Automation, Linux AT-SPI, screenshots, and input. The installed
  OpenAI CUA documentation exposes accessibility state, screenshots, indexed
  element actions, coordinate actions, and native-app/browser selection through
  a persistent JavaScript REPL. Therefore neither “screenshots versus
  accessibility” nor “VMs versus native apps” is an accurate general distinction.
  [Driver architecture](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/README.md).
- **Background operation has boundaries:** Cua Driver records successful and
  refused actions separately by OS and application framework. Its Windows
  support includes some semantic background actions; numerous input shapes
  remain refused. OpenAI documents macOS background use and Windows foreground
  use. The installed CUA documentation describes Linux input bound to a selected
  window without deliberately activating it or moving the pointer, while noting
  that applications can still activate windows or grab the pointer.
  [Driver empirical support ledger](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md),
  [OpenAI Computer Use documentation](https://learn.chatgpt.com/docs/computer-use).
- **Platform scope is not equivalent:** Cua Driver has Windows, macOS, X11 and
  compositor-specific Wayland implementations with documented gaps. LCU's
  current delivery targets Apple Silicon macOS and Linux ARM64/x86-64 with X11.
  Windows remains a candidate; native Wayland and Intel Macs remain unsupported
  by LCU. This research changes none of those claims.
  [Driver support ledger](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md),
  [LCU verification limits](../PARITY-STATUS.md).

## Installed official evidence

Read-only inspection of `/Applications/ChatGPT.app/Contents/Resources/cua_node/`
found `@oai/sky` package version `0.7.4` and `@oai/cua` version `0.2.5`.
These are package versions, not desktop-app or complete-runtime versions.
The inspected documentation was:

- `lib/node_modules/@oai/cua/docs/tinysky-alt-core-cua-repl.md`
- `lib/node_modules/@oai/sky/docs/sky-window-api.md`

The existing [signed-app verification](macos-current-app-2026-09-26.md)
records the Sky helper identity within the official app. OpenAI separately
[announced its acquisition of Sky's maker](https://openai.com/index/openai-acquires-software-applications-incorporated/).
The public acquisition announcement establishes ownership; local runtime
evidence establishes the installed component names and API surface.
No OpenAI instructions, source fragments, or application binaries were copied
into this document.

## Architecture follow-up

Read-only source inspection establishes four more specific distinctions:

1. **Agent execution boundary.** Cua Driver exposes structured commands through
   its Rust MCP/CLI runtime; SDK clients can load that runtime in process.
   OpenAI's CUA launcher starts the original Node REPL and registers separate
   trusted `sky` and `browser` services. Agent JavaScript keeps app/tab bindings
   between calls and can compose operations within one invocation. Both stacks
   retain state; this is a distinction in the exposed programming model, not a
   claim that Cua is stateless or cannot batch work in a client.
   [Driver interfaces](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md),
   [MCP implementation contract](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/mcp-protocol-and-skills.md).
2. **Native service boundary on macOS.** OpenAI's JavaScript Sky service selects
   a platform client. Its Mac client sends versioned, length-framed JSON-RPC
   over the trusted native-pipe facility to the signed helper. Requests include
   turn metadata and deadlines; helper startup can ask the application host to
   ensure the service. A static symbol inspection of the helper found Swift,
   AXUIElement, and ScreenCaptureKit references. Cua Driver's Rust platform
   module implements accessibility, capture and input directly, including
   AX actions and CGEvent/SkyLight PID-targeted input. No matching claim about
   Sky's precise low-level event-injection recipe is established here.
   [Cua macOS module](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-macos/src/lib.rs),
   [Cua input implementation](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-macos/src/input/mod.rs).
3. **Observation identity.** Cua's macOS click implementation resolves an opaque
   element token or an index paired with a snapshot ID before dispatch. Its
   optional pixel capture ID is admitted and consumed against the exact capture.
   The inspected OpenAI Mac client instead exposes app plus element index or
   coordinates, and maps the integer index into a helper element ID. The agent
   documentation requires a fresh observation before reusing indexes. This is
   an API-contract difference; it does not establish that the private helper
   lacks internal stale-target validation, or that either system wins a race
   against arbitrary application changes.
   [Cua click implementation](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-macos/src/tools/click.rs).
4. **Browser transport.** Cua's typed browser tools bind native windows to
   Chromium CDP targets, manage isolated profiles or explicitly authorized
   existing-profile connections, and retain session-scoped page references.
   OpenAI's unified browser service has multiple providers. LCU's external
   Chrome path uses the original browser extension and native messaging host;
   the official app also supplies an Electron in-app browser provider, and the
   runtime has a CDP provider. Thus the specific difference is LCU's normal
   external-Chrome connection, not an assertion that OpenAI never uses CDP.
   [Cua browser contract](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md),
   [OpenAI browser source audit](chrome-plugin-architecture-2026-09-24.md),
   [host boundary inventory](../HOST-INVENTORY.md).

Additional installed files inspected, relative to the selected `cua_node`:

- `lib/node_modules/@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js`
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js`
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/create_client.js`
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.js`
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js`
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/click.js`
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/get_app_state.js`

These findings explain why LCU requires host-service, approval and turn-lifetime
wiring in addition to launching an executable. No native helper was launched.

## Decision and missing evidence

For LCU, retaining Sky preserves reuse of the original Codex runtime. Adopting
Cua Driver would replace that engine and its API/permission behavior, rather
than merely change transport. It would provide an independently maintainable
driver, but would no longer meet LCU's current original-runtime requirement.

The reviewed sources establish no direct task-success, latency, or token-cost
advantage between the two drivers. Those comparisons require the same model,
applications, tasks, and independent outcome checks on disposable desktops.
No desktop interaction, installation, benchmark, or test was run for this
research. Public repository links track moving `main`; findings describe the
pages retrieved on the date above.
