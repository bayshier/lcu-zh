# `lcu origins`: saved Chrome site decisions

Date 2026-10-06. Source reading of the installed ChatGPT app 26.930.21537 (build 12776) on macOS, file `Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-service.mjs` (SHA-256 `770df1706f82057af518bd72269fbe7df4747e17f9b2c05205f11181921fdae3`). The code is minified, so the identifiers below are version-specific; the strings and constants are what to look for after an update. LCU only reads and removes entries in files the runtime already writes. No runtime behavior was changed.

## Observed in the source

| Fact | Where in the source |
| --- | --- |
| A harness session's saved decisions live in `browser/sessions/<session-id>.toml` under `CODEX_HOME`; a global store is `browser/config.toml`. | `lF` builds the stores: `aF(t, uS, ...)` with `uS="browser/config.toml"` and `` `browser/sessions/${r}.toml` `` for a session. |
| A session id must match `^[A-Za-z0-9_-]+$` and be 1 to 128 characters; anything else throws "Browser-use session id is invalid". | `lte`, called by `session(r)`. |
| The saved state is cached in memory for 300 seconds and re-read after that or after the runtime's own write. | `ste=300*1e3` and the `expiresAt` check in `da`. |
| The answer to a site prompt is written into the session store, or into the global one when the response asks to persist, as the `allowed` or `denied` list of an origin table. | `FQ` updates `t.global` or `t.session(preferenceSessionId)` and moves the origin between the two lists. |
| A saved denial is refused without a prompt: "A saved user permission setting blocks this action." (reason `persisted_user_denied`, source `browser-use-persisted-state`). | The reason table near `user_persisted_setting` and `Lt`. |
| A per-site setting with `access` "deny" under `origins` in the user's `config.toml` is also consulted. | `zM`, which reads `origins` entries and their `access`. |
| The runtime writes the whole file with its TOML writer (`config.writeToml`) and serializes its own writes in-process only. | `aF.update` and `ate`. |

## What LCU does with it

- `lcu origins list` reads `<CODEX_HOME>/browser/sessions/*.toml` and prints the string lists under `[origins]`.
- `lcu origins forget` removes matching strings and rewrites a file only when its content is plain tables of strings, booleans, integers and string lists without comments; the result is parsed back and compared before it replaces the original.
- It does not read or write `browser/config.toml` or `config.toml`, and it cannot add an entry to `allowed`.

## Not verified

- A live decline, `lcu origins forget`, and a fresh prompt in Chrome on the macOS verification guest.
- The exact on-disk layout the runtime writes, such as the key under which an origin's lists sit. The format is private to the runtime; LCU reads the `[origins]` table with `allowed` and `denied` lists as reported in issue 19 and fails closed on anything else.
- Whether other app versions keep the same layout.
