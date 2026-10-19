# `lcu apps`: always-allowed app list (macOS)

Date 2026-10-04. Observed on a live Apple Silicon Mac with the installed ChatGPT app (`cua_node` 0.0.27) and LCU 0.8.9. The original runtime's behavior below was observed, not changed: LCU only edits the same list the runtime and the Codex app already use.

## Observed facts

| Fact | Evidence |
| --- | --- |
| The list is `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`, shaped `{"approvedBundleIdentifiers": [...]}`. | Read on the live machine; also produced by the runtime in scratch HOMEs. |
| The runtime's `node_repl` writes this file when a reply to its approval request says "Always allow". The Codex app only lists and removes entries (Settings). | `11-grant-semantics.md` section 2 (tests t2/t6 and the app's `main.js` offsets). |
| A running runtime picks up outside edits at once, both additions and removals, with no restart. | Edited the file with the prototype while a session was running; the next app call used the new state. |
| Terminal, iTerm2, ChatGPT/Codex (`com.openai.codex`) and Notification Center are `forbidden`: the runtime refuses them before it asks anyone. | Live `getAppPolicy` query; `11-grant-semantics.md` section 3. |
| Browsers (Safari, Chrome, Zen), Passwords, Keychain Access and iPhone Mirroring are `high` risk: the approval card is marked "Elevated Risk". | Same query. Firefox, Edge, Brave, Arc, Opera, Vivaldi, Chromium, 1Password and Bitwarden are in the helper's same block of strings but were not installed here, so their risk is unverified. LCU lists them as high risk. |
| A bundle id the runtime cannot resolve is rejected as `Invalid app`. | `11-grant-semantics.md` section 3. |
| `deviceOwnerAuthentication` shows the system Touch ID prompt, with the login password as the fallback, from a plain command-line process launched from a non-terminal parent. The prototype helper was ad-hoc signed. | Prototype run (`lcu-research/lcu-apps/main.swift`): the prompt appeared and an approved reply edited the file. |

Sources: `lcu-research/11-grant-semantics.md` and the prototype in `lcu-research/lcu-apps/`.

## Design

- `lcu apps list` reads the file. It needs no authentication.
- `lcu apps allow APP` and `lcu apps revoke APP` run `bin/lcu-owner-auth`, a small Swift helper LCU compiles with `swiftc` when it builds the macOS archive. The helper only asks macOS to authenticate the owner and returns the answer in its exit status (0 approved, 1 cancelled or failed, 2 unavailable). It reads and writes no files, so the helper stays small and the edit logic is tested in Python.
- The Python side resolves the app (name, bundle id or `.app` path), refuses forbidden apps, warns for high-risk ones (and says so in the prompt text), asks for authentication, then edits the JSON. It skips the prompt when nothing would change (already allowed, or not in the list).
- The edit writes a temporary file in the same folder and renames it over the list, keeps the file mode, and keeps every other key. The runtime does not share a lock with LCU, so the file is re-read before the rename and after it. If another writer changed it in between, the change is recomputed from the new content. Only a write landing between the last read and the rename itself can be overwritten; that window is a few microseconds.
- A file that is not an object with a list of strings is reported and never overwritten.
- Authentication fails closed. A missing or non-executable helper, a cancelled or failed prompt, or no graphical console session for the account (for example an SSH login with nobody at the screen) leaves the list unchanged. The test suite injects the authenticator as a function argument, never an environment variable, so no setting can skip the prompt.
- Linux prints that the runtime has no per-app approval (see [the adapters document](../ADAPTERS.md)); Windows prints that it is unsupported.

## Signing and Gatekeeper

The archive's other native pieces are the installed OpenAI app and helper, used in place and never copied, modified or re-signed. `lcu-owner-auth` is LCU's own code: `scripts/build_bundle.py` compiles it and signs it ad hoc (`codesign --sign -`, identifier `org.amontlabs.lcu-owner-auth`). The prototype was ad hoc as well and its prompt worked, so no developer certificate is needed for `LAContext`.

The archive is built on the target Mac, so the helper matches its architecture. LCU releases are fetched with `curl` or `gh` or unpacked with `tar`, which do not set the `com.apple.quarantine` attribute. A browser-downloaded archive extracted by Archive Utility does; macOS may then block the first launch of the helper as an unnotarized download. Extract with `tar -xzf`, or run `xattr -dr com.apple.quarantine <extracted folder>` after verifying the checksum. Not verified here: a quarantined helper's behavior was not exercised.

## Verified by tests (no real list, no real prompt)

`tests/test_apps.py` uses a temporary HOME, fake `.app` bundles and an injected authenticator. It covers name, bundle id and path resolution (including ambiguity), list output and JSON, allow and revoke, idempotence without prompting, unknown keys preserved, malformed files left untouched, a racing writer (before the rename and right after it), a writer that never settles, parallel updates, forbidden and high-risk handling, the Linux and Windows messages, the real `authenticate` against stand-in helper scripts for each exit status, and a build of the Swift helper that checks its signature and usage errors without prompting. `tests/test_build_platforms.py` asserts the macOS archive contains `lcu/apps.py` and `bin/lcu-owner-auth` and the Linux archive does not contain the helper.

## Not verified

- A live Touch ID or password prompt from the built `lcu-owner-auth`, and an approved allow and revoke through `lcu apps` against the real list (the prototype proved the prompt and the edit; the shipped helper and Python path were exercised only with stand-ins).
- The helper's refusal with no console session over a real SSH login.
- A quarantined archive.
- Whether an enterprise policy (`allowPersistentApproval: false`) makes the runtime ignore list entries. The runtime then asks again whatever the list says.
