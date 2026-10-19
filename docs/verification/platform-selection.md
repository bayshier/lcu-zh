# Platform selection and installed macOS application evidence

This records the source evidence for the macOS application resolver. It does not
establish macOS desktop integration or Windows support.

The inspected local `/Applications/ChatGPT.app` identifies as
`com.openai.codex`, version `26.917.62051`, build `10789`, Team ID
`2DC432GLL2`. Its `Contents/Resources/cua_node/manifest.json` identifies a
`darwin-arm64` CUA runtime version
`0.0.16/20260915001755-492f19756c31`. The bundled
`@oai/sky/Codex Computer Use.app` identifies as
`com.openai.sky.CUAService` with the same Team ID. Read-only
`codesign --verify --deep --strict` on the outer application and strict
verification of the nested service both returned valid on disk and satisfied
their designated requirements when run outside the filesystem sandbox. The
same checks reported an invalid signature inside the restricted filesystem
sandbox, so that sandbox result cannot establish the installed app's validity.
With pins derived from the inspected local bundle in
`/private/tmp/lcu-mac-pins.json`, the read-only `resolve_installed_mac_app`
validation passed outside the sandbox. This proves the resolver accepts this
installed bundle; it does not prove a live MCP or desktop session.

The original CUA launcher at
`Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js`
calls `load_instructions(process.platform, CUA_REPL_BROWSER_ENV)`. Its
`instructions.js` maps `darwin`, `linux`, and `win32` to the `macos`, `linux`,
and `windows` instruction directories. The launcher includes only the
instructions for enabled browser and computer surfaces in its `js` tool
description. Thus a common distribution may carry all three instruction
trees without dumping all three into a model's tool description. LCU's
generated skill references still need matching platform selection.

The original Sky `load_options.js` maps `process.platform` to target `mac`,
`linux`, or `windows`; `create_client.js` dispatches to those original
clients. On macOS, `targets/mac/native-pipe.js` connects to the CUAService
socket in the OpenAI application group. If absent, it requests the service
through `nodeRepl` host services or `launchServices.openApplication`, with
`SKY_CUA_SERVICE_PATH` or a CODEX_HOME-local service path before the bundle
identifier fallback. This requires the signed helper and host permission
integration; shared JavaScript files alone are insufficient. The installed
Mac application contains the signed helper. A Windows client and spawned
helper transport exist in the same JavaScript package, but no matching
Windows application and helper binary were inspected. Windows must stay
disabled until its installed package and runtime behavior are verified.

`lcu/platforms.py` validates a local Mac bundle in place. The caller must
supply version, CUA runtime version, and SHA-256 pins for every required
runtime entry. The resolver verifies bundle identities, architecture, hashes,
executable bits, and the app/helper signatures and Team IDs. It does not
copy, rewrite, launch, or re-sign upstream files. The Linux managed-package
validator remains separate. Unit tests cover success and rejection paths
with a disposable bundle and mocked `codesign`; no desktop or browser was
controlled. The bounded [MCP startup comparison](macos-runtime.md) subsequently passed.
A real desktop action remains required before claiming standalone macOS
computer-use parity.
