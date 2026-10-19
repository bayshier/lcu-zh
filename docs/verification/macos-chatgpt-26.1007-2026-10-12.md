# macOS ChatGPT 26.1007.30912 check, 2026-10-12

Installed-app and desktop checks for ChatGPT 26.1007.30912 with CUA 0.0.29/20261005054403-144090e2ddcb on
darwin arm64, the pair `lcu doctor` reported as untested. At the user's request it ran on the user's own Mac. LCU
writes went to scratch directories under `/private/tmp`; the desktop steps used the installed LCU and the
user's approvals. **Result: the archive installed offline, reusing the signed app in place, and its commands
passed; one model-driven desktop task each through Claude Code + LCU and Codex CLI + LCU completed, with an
independent file check; `js_reset` removed Sky's event taps.**

## Host and app

| Item | Value |
| --- | --- |
| Machine | User's Mac, macOS 26.5 (25F71), arm64 |
| ChatGPT.app | 26.1007.30912 (build 20156), signed `com.openai.codex`, team 2DC432GLL2; `codesign --verify --deep --strict` passed before and after |
| CUA runtime | 0.0.29/20261005054403-144090e2ddcb |
| Codex Computer Use.app | 26.1005.1001425 |
| Node | `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`, v24.21.0 |
| LCU | 0.11.2 (`f32d497`); installed copy at `~/.local/share/lcu/current` reports the same pair |
| Agents | Claude Code 2.1.204, codex-cli 0.160.0 |

## Installed-app check

- `scripts/build_bundle.py --platform darwin --app /Applications/ChatGPT.app --output dist/verify-26.1007` built
  `lcu-0.11.2-darwin-arm64.tar.gz` (SHA-256 `106301d3c4187dcf06fdb276a852fa8c062a644ccf2b7c75b2768e95c05e1203`,
  matching its sidecar). It stays in `dist/`, out of Git.
- `scripts/install.sh --prefix /private/tmp/lcu-verify-26.1007 --offline --runtime-only --yes` exited 0 and
  printed `The signed application is reused in place.` A `/tmp/...` prefix is refused because `/tmp` is a
  symbolic link on macOS (`Refusing a symlink in setup destination: /tmp`), as designed.
- From that prefix, `--version` printed `lcu 0.11.2 (ChatGPT darwin 26.1007.30912; CUA
  0.0.29/20261005054403-144090e2ddcb)`; `doctor` reported the same pair with `Tested pair: no.` and `Original Mac
  provider loaded; app listing and app-state methods are available.`; `doctor --help` and `prune` exited 0.
- `node --test tests/node/*.test.mjs`: 410 passed, 29 skipped, 0 failed. `node --test adapters/test/*.test.mjs`:
  186 passed, 8 skipped, 0 failed.

## Desktop checks

`/tmp/lcu-taps/taps <pid>` (a scratch Swift tool around `CGGetEventTapList`, read-only) listed event taps.

**Sky service.** With CUA 0.0.29 the Sky service LCU reached was the one ChatGPT itself started from
`~/.codex/computer-use/Codex Computer Use.app` (parent: `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`), the
same version as the copy inside the app bundle. No separate service ran from the bundle. Its taps for other
turns were present before the run; the counts below are for this run's apps.

### Claude Code + LCU

This session, through the installed Claude relay (`adapters/claude.mjs`), one turn:

| Step | Result | Sky taps / relay log |
| --- | --- | --- |
| Calculator: All Clear, 1 2 7 × 8 = by element clicks | Display `1 016`, expression `127×8` | Global `0x200000`, ViewBridgeAuxiliary `0x1c00`, Calculator `0x182000` + `0x1c00`, listen-only |
| `js_reset` (+1.5 s) | Reset | 0 taps; `turn_end` Interrupt, `cause: js_reset`, ok, `sky_hook: live` (33 ms) |
| Finder, same turn after the reset | Window for `/private/tmp/lcu-desktop-check` showed `note.txt`, 10 octets | `call_end` ok |
| TextEdit: `setValue` on the text view, then Fichier › Enregistrer | Saved | `call_end` ok; 8 taps, including TextEdit and Finder `0x182000` + `0x1c00` |
| Turn end (`Stop`, +49 s) | — | 0 taps; `turn_end` Stop, ok, `sky_hook: live` (35 ms) |

Independent check: `note.txt` on disk read `LCU check` / `Calculator: 127 x 8 = 1016` (37 bytes, SHA-256
`603f9b49291fc36774bfcaa6aa5c88eb480620afa23b00951f9c3df9b058e8a7`).

Notes:

- Finder's `Ouvrir un élément du Finder` secondary action on the file row returned without opening the file;
  the file was opened with `open -a TextEdit` from the shell, and only the editing and saving went through LCU.
- When TextEdit first showed `note.txt`, its text view read `U LCU check` and was marked modified, before any
  LCU input to TextEdit. The file on disk did not contain the `U`. The source was not identified; the
  `setValue` replaced the whole text.

### Codex CLI + LCU

`codex exec --skip-git-repo-check -C /private/tmp/lcu-desktop-check -s workspace-write -c
approval_policy='"never"' "<task>" < /dev/null`, through the installed Codex relay (`adapters/codex.mjs`).
Calculator and Finder are always-allowed, so the headless run needed no approval panel. The task: compute
365 × 24 in Calculator by clicking its buttons, read the file name and size from the Finder window, and write
both to `codex.txt`.

- Codex made five `lcu/js` calls and no AppleScript or shell UI calls. It wrote `calculator=8 760` and
  `finder=note.txt 37 octets`.
- Independent check: 365 × 24 = 8760, and `stat` gave 37 bytes for `note.txt`.
- The relay logged `turn_end` Stop, ok, `sky_hook: live` (38 ms).
- Without `< /dev/null`, `codex exec` waited on stdin (`Reading additional input from stdin...`).

## Not verified

- Linux and Windows; this pair is darwin arm64 only.
- The shared client relay and the macOS lifetime host's cleanup at stop.
- The browser surfaces (Chrome and the in-app browser).
