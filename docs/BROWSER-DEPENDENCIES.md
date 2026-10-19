# Browser providers and external dependencies

Historical source audit for the earlier full-copy candidate. The current library targets the installed application's native Linux and external Chrome providers; see [installation](INSTALLATION.md) and [current status](PARITY-STATUS.md).

LCU preserves the complete browser client shipped in OpenAI's Linux package `26.915.31945`. A client API and its instructions do not create the browser backend that performs the operations. Native desktop control, Chrome extension control, the local in-app browser, and cloud/CDP providers have different dependencies.

## Cloud/CDP

The pinned package contains CDP client capability, but the audit found no CDP backend implementation or launcher in the distribution. Cloud/CDP operation requires a compatible backend supplied by its environment. Selecting the `cloud` or `orbit` instruction mode is not evidence that such a backend is running.

This conclusion comes from both positive transport code and a bounded search outside `cua_node`:

- The unchanged `@oai/browser-desktop/scripts/browser-service.mjs` selects `/tmp/codex-browser-use` on Linux (`Ta`, byte offset 726706).
- `qZ` and `jZ` enumerate existing entries in that directory (1678709). `hf.create` opens `nodeRepl.nativePipe.createConnection` (1666260); `MZ` and `NZ` connect and request backend `getInfo` (approximately 1676800–1677090). This path discovers and connects; it does not launch a backend.
- `CDP_BROWSER_BACKEND_PIPE_PATH` is an optional exact-socket filter in `GB` (1675433), applied only when `BROWSER_AUTH_EVAL_EXACT_CDP_BACKEND_SOCKET=true`. It does not accept a raw CDP WebSocket URL or start a browser/server.
- Original `.package-map.json`, `.modules.yaml`, `.pnpm/lock.yaml`, and `.pnpm-workspace-state-v1.json` name `@oai/cdp-browser-backend` and `packages/oai_js_cdp_browser_backend_build.tgz`. The actual package directory and tarball are absent from the complete official `.deb` file list. The extracted `@oai` directory contains only `browser-desktop`, `cua`, `cua-repl`, and `sky`. Residual build metadata does not supply the missing package.
- A scan of the complete `app.asar` inventory covered 15,480 entries, including all 15,110 packed files, and found no CDP backend package, launcher, or `type: cdp` provider. Both original `codex` and `codex-code-mode-host` executables lack the CDP backend package/pipe identifiers. The CLI's `full_cdp_access` strings are policy controls, not a server implementation. `codex debug --help` advertises no browser backend launcher.
- The package includes generic Playwright CDP transport/relay modules. Those modules do not by themselves implement the browser runtime's native-pipe discovery and `getInfo` protocol.

The absence finding is bounded by this inspected package and the searches above. It does not claim that no other OpenAI distribution or external service supplies the backend. All shipped CDP client code and instructions remain in LCU.

## Local in-app browser

The local IAB implementation **is present** in the original Electron application. It must not be grouped with the absent external CDP service.

In `app.asar`'s `.vite/build/main-DUHZj4_w.js`, the IAB provider's `getInfo` returns `name: Codex In-app Browser` and `type: iab` (offset 2367180), along with session metadata and browser/tab capabilities. The same main bundle defines the shared native-pipe directory at offset 54137. This provider depends on Electron host facilities; copying `cua_node` alone does not recreate them.

At the time of this audit, a local IAB host was being integrated and tested separately. That candidate is outside the installed-app library's current release scope. The package inventory and configuration-mode matrix did not prove IAB operations.

## What configuration tests establish

The differential configuration matrix checks the original tool schemas, complete first-use instructions, and exposed methods across computer-only, browser-only, and combined surfaces in `codex-app`, `training`, `cloud`, and `orbit` modes. It does not count initialization as successful browser control. Browser operations require a real provider and separate evidence.

Production security and authentication requirements remain the upstream requirements. A test using the original explicitly configured local-testing mode is evidence about that mode; it does not establish production authentication or approval behavior.

## Source identity

These offsets refer to pinned package `26.915.31945` and runtime `0.0.16/20260915001755-492f19756c31`, verified against [runtime.lock.json](../runtime.lock.json). The inspected ARM64 `@oai/browser-desktop/scripts/browser-service.mjs` SHA-256 is `fa354758746c6d4569a3d63474246ba64dcfb9a3f2572927218afa281cb281c3`. The `.deb` is the [official ARM64 artifact](https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.915.31945_arm64.deb). Source searches, excerpts, binary scans, and CLI help output were retained as local verification evidence for this audit.
