# Chrome plugin, browser extension, and LCU

Read-only source audit on 2026-09-24 of LCU `80ef029` and the pinned local `/Applications/ChatGPT.app` 26.917.62051. Two Sol agents independently traced the original package and LCU integration. No browser was opened, no extension was installed, and no product behavior changed for this research.

**Later implementation:** the default-on setup described below is a historical snapshot. [Chrome opt-in](chrome-opt-in-2026-09-24.md) is now implemented and verified, including live macOS Chrome actions. Default setup no longer registers the connector.

## Distinct components

### Names that must not be conflated

The installed application has separate `computer-use`, `unified-computer-use`, `browser`, and `chrome` plugin directories. The `computer-use` skill explicitly imports `@oai/sky` and even demonstrates native access to the Google Chrome application through `sky.get_app_state`. That route observes and operates an OS application window; it does not require a Chrome extension.

LCU targets the different, unified `@oai/cua-repl` runtime behind `cua`. Its original `create_tinysky_alt.js` separately loads Sky for the computer surface and a bundled browser client for the browser surface. `cua.getApp(...)` binds the native path; Chrome `cua.getBrowser(...)` / `cua.createBrowserTab(...)` bind the browser path. Browser use is therefore a capability included in this unified tool, not a synonym for native desktop control. The Chrome extension is needed for that external-Chrome browser path, not merely because the target desktop app is Chrome.

The `browser` plugin is the separate skill-based entrypoint for the in-app browser. The `chrome` plugin is another skill-based entrypoint for external browsers and packages the original native-host assets. Neither plugin's skill activation is a prerequisite for the unified runtime's own browser API. The in-app browser and external Chrome are different browser backends; the former does not use Chrome's extension and is not supplied by LCU.

LCU's default `browser,computer` surfaces preserve an existing original unified-runtime capability. LCU's decision to run the original Chrome native-host installer unconditionally during agent registration is its own setup policy. The latter must not be presented as proof that native Computer Use requires Chrome integration.

OpenAI's [plugin architecture documentation](https://developers.openai.com/plugins/concepts/plugins) distinguishes a plugin package from the skills, tools, and hooks it can contain. Its [browser extension setup guide](https://learn.chatgpt.com/docs/chrome-extension) separately instructs users to enable the relevant desktop plugin and install the browser extension in their chosen browser profile. The browser extension and the desktop plugin are different installations.

The installed app's `Contents/Resources/plugins/openai-bundled/plugins/chrome` contains:

| Component | Role and inspected source |
| --- | --- |
| Agent instructions | `skills/control-chrome/SKILL.md` and `docs/`. The skill bootstraps `scripts/browser-client.mjs` through Codex's Node execution tool, then uses `agent.browsers` and returned browser documentation. |
| Browser code | `scripts/browser-client.mjs`, `scripts/browser-service.mjs`, supporting modules and WebAssembly. A skill alone does not supply this executable behavior. |
| Local Chrome connector | `extension-host/macos/arm64/ChatGPT for Chrome`, with `scripts/installManifest.mjs`. The installer registers the original `com.openai.codexextension` native messaging host and its runtime paths. The matching Linux package supplies Linux executables. |
| Setup and diagnostics | Scripts to inspect extension installation, native-host registration, browser installations and running state; `extension-ids.json` identifies official store entries and platform paths. |
| Codex packaging and cleanup | `.codex-plugin/plugin.json` declares metadata, `skills: ./skills/`, and Stop/Interrupt/SubagentStop hooks targeting `node_repl.turn_ended`. This Chrome package has no `.mcp.json` and declares no standalone MCP server. It relies on the host's execution tool. |

The actual ChatGPT browser extension runs inside the selected Chrome profile. It is not supplied merely by copying the plugin skill or by installing the native messaging connector.

## Why the unified tool does not need the Chrome skill activated

The installed app also contains a separate `unified-computer-use` plugin. Its `.mcp.json` describes `cua_repl`, and its manifest targets that server's cleanup tool. This is the original unified `cua` interface used by LCU and exposed in this research session.

The exact original launcher at `cua_node/lib/node_modules/@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js` assigns the browser service to `@oai/browser-desktop/service` when the browser surface is enabled. `@oai/browser-desktop/package.json` exports its own `scripts/browser-service.mjs`. It does **not** directly import the Chrome plugin's `scripts/browser-client.mjs`; these are distinct bundled entrypoints and files. The unified interface supplies native app and browser methods through `cua`.

Thus, files bundled on disk, activating the separate Chrome plugin/skill in a session, and having a working extension connection are three different conditions. The unified tool can expose browser methods without that separate skill being active. External Chrome still needs its connected extension and local native host. Availability of methods alone does not prove a live browser connection.

The original browser service discovers local browser backend pipes and connects using the trusted native-pipe API. Native-host binary strings also reference app-server spawning/proxying; this audit does not claim a newly observed live macOS process topology from those strings.

## What LCU already does

- [Runtime launch](../../lcu/runtime.py) resolves the pinned installed app and starts its original CUA server, with its original browser and computer services. It supplies the executable paths and environment that Codex normally supplies.
- [Generated instructions](../../lcu/setup.py) copy applicable original documents locally and register the LCU skill. The wrapper (`skills/lcu/SKILL.md`, removed on 2026-10-01; see [instruction delivery](../INSTRUCTIONS.md)) distinguishes the unified `cua` API from the separate Chrome plugin's `agent.browsers` bootstrap; the latter is preserved as reference material, not treated as interchangeable startup instructions.
- [Browser setup](../../lcu/browser.py) makes an account-local writable copy of the original Chrome plugin, runs its original native-host installer, and points the generated native messaging manifest at LCU's small relay. It does not activate the Chrome plugin in Codex or install the browser extension.
- [The relay and environment adaptations](../STANDALONE-ADAPTATIONS.md) provide the local agent-header decision and disable account/telemetry initialization through the original switch. Original browser actions and origin approval remain in the original runtime.
- [Harness integration](../ADAPTERS.md) supplies tools, instructions and the host callbacks that are implemented. Claude currently has MCP/skill registration only, with no per-turn cleanup wiring. Browser permission and lifecycle compatibility must be assessed per harness.

The [final Linux artifacts](focused-delivery-2026-09-24.md) already passed original Chrome-extension actions without a Codex sign-in. macOS Chrome has no corresponding live proof; Windows browser setup is unimplemented. This research did not rerun those tests.

## Correction to the optionality claim

The browser extension is unnecessary for native desktop actions, including interacting with a browser window through the OS. However, current `lcu setup --agent ...` unconditionally calls `install_browser_host` before registering the agent (`lcu/setup.py:643-649`). It can therefore change account-level native messaging registration even for a native-only user. The [installation guide](../INSTALLATION.md) already notes that this registration can affect other apps using the same extension.

Runtime validation also requires the Chrome plugin files, and skill generation copies their guides. This is an installed-app file dependency, not a requirement to activate the plugin in the harness or enable the extension in Chrome. A missing browser extension is reported after setup without failing native setup.

The concrete remaining setup change is to make native-host registration an explicit optional browser setup step, and prove native-only setup/control without that registration. That change has not been implemented by this audit. It requires no replacement browser engine or new Chrome plugin for each harness; platform verification and existing permission/cleanup gaps remain separate work.
