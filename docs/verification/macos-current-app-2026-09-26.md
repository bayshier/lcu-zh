# macOS current-app compatibility check, 2026-09-26

The installed signed ChatGPT app passed LCU validation without matching a repository app-version, CUA-runtime-version, or component-hash allowlist. LCU recorded and reported the values read from the selected app: ChatGPT `26.924.22138`, CUA runtime `0.0.24/20260924074400-f52ea85e2a98`, arm64.

The selected app at `/Applications/ChatGPT.app` has bundle identifier `com.openai.codex` and OpenAI Team ID `2DC432GLL2`. `codesign --verify --deep --strict --verbose=4 /Applications/ChatGPT.app` reported “valid on disk” and “satisfies its Designated Requirement”; the embedded `com.openai.sky.CUAService` helper passed the same verification and Team ID check. The app’s original Codex CLI and code-mode host are at `Contents/Resources/codex-cli/bin/{codex,codex-code-mode-host}`. The [shared locator](../../lcu/app_layout.py) recognizes this pair and the prior root-level pair. The [macOS validator](../../lcu/platforms.py) still checks app/helper identity and signature, runtime platform/architecture, executable permissions, and required files.

An isolated LCU source payload was sealed and installed into `/private/tmp/lcu-unpinned-macos-smoke-20260926-audio-codex/prefix`; the installation reused the signed app in place. Its descriptor recorded the observed versions above. Release validation ran the installed `lcu --version`, original `node_repl --help`, and original CUA setup probe. No personal configuration or GUI was used.

`python3 -B tests/macos_session.py --release /private/tmp/lcu-unpinned-macos-smoke-20260926-audio-codex/prefix/current --app /Applications/ChatGPT.app` passed against both the direct original server and installed LCU: MCP initialize, original tool schemas/descriptions, macOS guide selection, pure JavaScript result `42`, persistent JavaScript state, and `js_reset`. The check reported zero provider actions. The host printed its temporary-`CODEX_HOME` PATH-alias warning before completing these checks.

The [instruction generator](../../lcu/setup.py) also materialized the skill under an isolated task-owned home. It copied these selected original files byte-for-byte from the installed app:

- `@oai/cua/docs/tinysky-alt-core-cua-repl.md`
- `@oai/cua-repl/instructions/macos/description.md`
- `@oai/sky/docs/skills/oai_sky_lib/macos/SKILL.md`

This validates the current signed app’s install, original CUA initialization and JavaScript/reset path, and selected macOS instruction sources. It does not verify computer-use GUI actions, Chrome, or provider behavior.
