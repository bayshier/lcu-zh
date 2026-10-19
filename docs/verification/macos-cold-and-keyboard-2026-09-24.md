# macOS helper boundary and keyboard check, 2026-09-24

The user authorized a bounded personal-laptop test for this session. The installed dependency was signed `/Applications/ChatGPT.app` 26.917.62051 with original CUA runtime 0.0.16/20260915001755-492f19756c31. The selected LCU release was `/private/tmp/lcu-delivery-install/current`. No original file, app permission, browser extension, or production configuration was changed.

## Trusted startup bridge

Run `python3 tests/macos_cold_path.py --release /private/tmp/lcu-delivery-install/current --app /Applications/ChatGPT.app` on the inspected Mac. It creates disposable HOME/CODEX_HOME directories and a small test-only trusted RPC service. Through both the direct original `@oai/cua-repl` executable and selected LCU executable, that service observed `nodeRepl.launchServices.openApplication` and `nodeRepl.nativePipe.createConnection` as functions. It passed a verified nonexistent absolute `.app` path to the original LaunchServices bridge. Both returned `LaunchServices application path does not exist`. The results were equal; no GUI app or native helper was launched by this probe.

The original `@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js` first connects to the native socket, then requests `ensureService` through `NODE_REPL_HOST_SERVICES_PIPE_PATH` if present, otherwise calls `nodeRepl.launchServices.openApplication` with `SKY_CUA_SERVICE_PATH`, a CODEX_HOME-local app, or bundle ID `com.openai.sky.CUAService`. LCU does not have to supply a proprietary Codex host-services process for this LaunchServices fallback. The no-GUI probe confirms the trusted bridge exists in the packaged worker; it cannot prove that the helper will actually launch or receive first-use OS permissions.

The same original client source accepts `SKY_CUA_SERVICE_NATIVE_PIPE_PATH` for the client socket. The signed helper executable also contains that name, but its exact server-side semantics and a distinct-instance launch mode were not established. Its Info.plist identifies `com.openai.sky.CUAService`. LaunchServices may activate the already running same-user instance. A separate socket path alone is not proof of an isolated fresh helper. The existing helper was not stopped. A full cold-start and permission test requires a fresh macOS user/session or another demonstrably isolated helper instance; neither was available in this run.

Private raw probe output: `/private/tmp/lcu-macos-launchservices-probe.json`.

## `super+w` on this French keyboard

In a newly created, unsaved TextEdit document, original CUA through LCU typed a marker and `pressKey('super+w')` left the same document open with empty text. The Edit menu showed Undo disabled and Redo Typing enabled. The direct original `@oai/cua-repl` process, without `bin/lcu`, produced the same result on a second disposable unsaved document. Both documents were restored with Redo, closed using the observed close button, and explicitly discarded. No saved user document was affected.

The original JavaScript forwards the key string unchanged to the compiled helper. The UI observation establishes that this shortcut acted as Undo in both paths. The precise native keycode/layout translation is not visible in source, so the keyboard-layout mechanism is unproven. This is an upstream behavior on this machine, not an LCU adapter difference. The prior native check in [macos-live-2026-09-24.md](macos-live-2026-09-24.md) remains a proof of the exercised click/type/screenshot/save flow, not universal keyboard parity.
