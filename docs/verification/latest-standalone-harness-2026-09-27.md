# Latest standalone Pi and Claude Code host verification

Run on macOS 26.5 (build 25F71) on 2026-09-27. The host used Node.js 26.10.0 and Python 3.14.0. These are single-host compatibility checks, not a cross-platform matrix.

## Versions and setup

- Pi: installed the official `@earendil-works/pi-coding-agent@0.87.1` package into a temporary npm prefix and confirmed the executable itself reported `0.87.1`. Pi's project changelog documents the package move from `@mariozechner/pi-coding-agent`; 0.73.1 was the last old-scope release. The [current package](https://www.npmjs.com/package/%40earendil-works/pi-coding-agent), [package migration notice](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home), and [Pi package guide](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/packages.md) describe this package and extension installation. The actual `pi install <local adapter package>` command registered the adapter in an isolated `PI_CODING_AGENT_DIR`; its `settings.json` contained the adapter package path, and Pi launched without direct-extension flags.
- Claude Code: installed official version 2.1.278 into a temporary HOME and confirmed the actual guarded `clod --version` output was `2.1.278 (Claude Code)`. Stream-JSON initialization events also reported `claude_code_version: 2.1.278`. The [official 2.1.278 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.278), [versioned installation instructions](https://code.claude.com/docs/en/setup), and [CLI reference](https://code.claude.com/docs/en/cli-reference) document release and CLI behavior.

The Pi package peers and type imports now use `@earendil-works/pi-coding-agent` and `typebox`, matching the current package's extension documentation. Both remain optional peers because the host supplies these packages when loading the extension.

## Result delivery

The LCU host fixture requested one `js` tool call against a local scripted provider for each of four original MCP result types. Pi ran the installed package mode and passed all four cases: text, image, audio, and error. Claude Code passed the same four cases through its relay and a local Anthropic-compatible scripted provider. The provider observed one tool call and one tool-result request in each Claude case; the optional title-metadata request was not required.

- Text: original result content reached the provider.
- Image: the original PNG bytes and provider image payload matched SHA-256 `036db0272ba76df7711c9cf4257808effcb0fc3c9e02f9e5d0007060cd497ed5` in both host adapters.
- Audio: the original WAV was saved byte-for-byte with SHA-256 `9d3f06e364a9665a7cd302327f3a84799952d7def702d590a2cdbecd71bab515`. The providers received the saved-file reference, not WAV bytes.
- Error: the original error reached the provider; Claude preserved `is_error=true`.

For Pi, the latest-package test command was:

```sh
PI_BIN=/private/tmp/lcu-pi-cli-0.87.1/node_modules/.bin/pi \
PI_VERSION=0.87.1 PI_INSTALL_PACKAGE=1 \
LCU_RESULT_EVIDENCE_DIR=/private/tmp/lcu-result-pi-0.87.1-package \
node --test adapters/test/result-pi-host.test.mjs
```

The run passed 4/4 cases after package registration through `pi install`. The existing approval and lifecycle contract tests also passed 15/15:

```sh
node --test adapters/test/pi.test.mjs adapters/test/pi-approval.test.mjs adapters/test/claude.test.mjs
```

Claude's actual host run used the existing `clod` manual gate with an interactive TTY and the literal `START CLAUDE` authorization for each CLI launch. The guard itself was not changed or bypassed. Claude ran with `--permission-mode default` and the single fixture tool explicitly allowed; it did not use `bypassPermissions`. The fixture set `ANTHROPIC_BASE_URL` to a loopback-only scripted provider and used a synthetic key.

## Limits

These runs verify LCU result transport through the current public host CLIs against synthetic providers. They do not prove a live model interpreted an image, audio understanding, a real desktop screenshot capture, a paid-provider request, or behavior on Linux/Windows. The image is a synthetic original tool-result payload, not a screenshot captured during this run. Audio is represented to both providers by a local-file reference. Native approval UI behavior remains covered by its separate contract tests, not by this headless result-delivery fixture.
