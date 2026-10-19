# macOS permission onboarding evidence, 2026-09-27

LCU uses the signed ChatGPT application's original computer-use runtime. Its CLI does not have a public read-only API for macOS Accessibility or Screen Recording grant state. The onboarding guide therefore names the selected app and helper, offers the native Settings panes only after an explicit choice, and reports readiness as unverified until an agent's first approved screenshot call.

The inspected installed app was `/Applications/ChatGPT.app`. Its runtime was `/Applications/ChatGPT.app/Contents/Resources/cua_node`, with Node at `bin/node` and the original service at `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js`. The relevant original source files were:

- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js`, which exposes the `setup` RPC and the public service methods.
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.d.ts`, which declares the Mac client methods; it has no permission-status method.
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/create_client.js`, which constructs the original Mac client and exposes `list_apps` and `get_app_state`.
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/computer-use-policy.js`, which requires the original `nodeRepl.createElicitation` approval before app-scoped computer-use operations.
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js`, which requires the original `nodeRepl.nativePipe` and LaunchServices path.
- `lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/errors.js`, whose `permissionsNotGranted` (`-10009`) and `permissionsPending` (`-10014`) errors do not identify which permission is absent.

A live metadata-only call through the selected app's original signed Node runtime returned `target: mac` and the methods `list_apps` and `get_app_state`. It did not call either app-inspection method, request an elicitation, or capture screen content. LCU consequently reported macOS permissions as unverified. The probe also confirmed that the installed helper's Info.plist display name is **ChatGPT Computer Use** at `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app`; the main app display name is **ChatGPT** at `/Applications/ChatGPT.app`. The implementation reads these names and paths dynamically from the selected bundles rather than hardcoding them.

The Mac Settings links use Apple's existing privacy panes:

- `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
- `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`

The probe never opens either URL automatically. macOS permission readiness remains unverified until the user reconnects the agent, chooses a harmless visible window, and approves the original agent request and OS prompts.

## Validation

The live selected-app metadata probe returned `target: mac`, `list_apps`, and `get_app_state`, while leaving permission state unverified. The focused readiness, Windows runtime, macOS installer/runtime, platform-build, and general runtime suites passed 57/57 tests.

The original Linux doctor check also passed in the existing `lcu-verification:arm64` image, with no image build. The disposable Ubuntu 24.04.5/aarch64 guest used official ChatGPT 26.915.31945 and CUA 0.0.16/20260915001755-492f19756c31, verified against the runtime lock. In a fresh `lcutester` D-Bus session with disposable Xvfb/Openbox and GTK/X11 fixtures, `lcu doctor --non-interactive --require-ready` reported four windows and one screenshot, discarded the returned image data, and exited 0. The container ran with `--network none`, read-only source/package/script mounts, and `--rm`.
