# Claude Code plugin: install and register from the plugin manager (macOS)

Date 2026-10-06. Checked on one Apple Silicon Mac (macOS 27.0) with Claude Code 2.1.289, the installed ChatGPT app 26.924.22138 and the LCU 0.9.5 release archive. The unit tests also ran in an Ubuntu 24.04 arm64 VM. The plugin changes no runtime, relay or setup code: it is one `SessionStart` hook, `adapters/claude-plugin/scripts/ensure-lcu.sh`, that runs the existing installer and `lcu setup`.

No check below controlled a desktop, and none wrote to the default Claude Code configuration or to `~/.local/share/lcu`.

## Checked

| Check | Result |
| --- | --- |
| The hook against a stand-in release and a recording `lcu` (`tests/test_claude_plugin.py`). | All 16 cases pass on Ubuntu 24.04 arm64 (Python 3.12.3, `dash` as `sh`). On the Mac, 15 pass under `sh` and under `dash`; the missing-Python case skips itself there because a Python 3.12+ is in `/opt/homebrew/bin`, which the hook always searches. |
| The hook's install half against the real release, into a scratch `LCU_PREFIX`. The registration lines were cut from that copy of the script. | It read `v0.9.5` from the `/releases/latest` redirect, downloaded `lcu-0.9.5-darwin-arm64.tar.gz` and its `.sha256`, matched the checksum, and ran the archive's `scripts/install.sh --prefix <scratch> --existing-app /Applications/ChatGPT.app --runtime-only`. LCU 0.9.5 was installed under the scratch prefix in 8.5 s; the lock and the temporary directory were gone afterwards. |
| The registration arguments against that installed LCU 0.9.5. | `lcu setup --prefix <scratch> --agent claude-code --yes --validate-only` exits 0. With `CLAUDE_CONFIG_DIR` set it exits 1 with "CLAUDE_CONFIG_DIR is not supported by the bundled installers for claude-code", which is why the hook stops earlier in that case. |
| The plugin directory in Claude Code (`claude -p --plugin-dir adapters/claude-plugin`), with `LCU_PREFIX` pointing at a recording stand-in for `lcu`. | The plugin loaded, the hook ran `setup --prefix <prefix> --agent claude-code --yes` once, and its message arrived as the hook's `systemMessage`. A second session ran the hook silently and made no further call. |
| Marketplace install into a separate `CLAUDE_CONFIG_DIR`. | `claude plugin validate` passes for the repository (marketplace) and for the plugin. `claude plugin marketplace add <checkout>` and `claude plugin install lcu@lcu` copied only the plugin's three files. A session in that configuration got the `CLAUDE_CONFIG_DIR` notice once and nothing in the next session; the plugin's data folder there was `plugins/data/lcu-lcu`. |
| An MCP entry written to `.claude.json` while a session is starting, which is what `lcu setup` does from the hook. Tried with a throwaway hook in a separate configuration directory. | The entry was still in the file after three headless sessions, and `claude mcp list` listed it. |

## Not checked

- The real `lcu setup --agent claude-code --yes` has not been run from the hook. A first session that installs, registers, is followed by a restart and then by a computer-use call has therefore not been observed on a clean account.
- Interactive sessions and the Claude app's Code tab. Every Claude Code run above was headless (`claude -p`).
- A session started with a short `PATH`, such as from the Dock.
- What Claude Code does when the hook reaches its 300 s timeout.
- Linux, Intel Macs and Windows. The hook does nothing there except say so once.
