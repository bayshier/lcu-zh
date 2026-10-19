# Bounded macOS MCP comparison

`tests/macos_session.py` compares two separate stdio MCP processes on macOS:
the original `@oai/cua-repl` launcher from a locally installed ChatGPT.app and
LCU's launcher using the same installed application. The original process gets
an independently constructed environment; it does not use LCU's environment
builder. Both processes use disposable HOME, CODEX_HOME, and temporary paths.
The script forwards no account credentials or personal Codex configuration.

The bounded check compares MCP initialization, original `js` and `js_reset`
tool schemas and descriptions, the selected macOS first-use guidance, pure
JavaScript calculation, persistent REPL state, and reset behavior. It never
calls `getState`, `getApp`, Sky, Chrome, browser discovery, or the native
computer-use helper. A pass proves only MCP transport and instruction parity
for this configured installed-app path. It does not prove GUI permissions,
native app control, browser control, host approval delivery, or service
lifecycle parity.

On a prepared release, run:

```sh
python3 tests/macos_session.py \
  --release /private/tmp/lcu-macos-validation/current \
  --app /Applications/ChatGPT.app
```

On 2026-09-24, this passed against
`/private/tmp/lcu-macos-validation/releases/0.3.0-5dcd4feba2fe` and the
installed `/Applications/ChatGPT.app` 26.917.62051. The script used Python
3.14, isolated temporary homes, and no provider calls. MCP initialize,
original tool schemas/descriptions and macOS first-use guide, pure JavaScript,
persistent state, and `js_reset` matched exactly. The same original-only
exercise passed independently. Inside Codex's outer filesystem sandbox,
the original Node REPL's nested macOS `sandbox-exec` failed with
`sandbox_apply: Operation not permitted`; the successful comparison ran
outside that outer sandbox while retaining the runtime's own sandbox.

The original server uses the app's Node and `cua-repl.mjs` directly. The
application remains in place; the comparison neither copies nor launches
the desktop app. Only a separate real desktop integration test can establish
macOS native computer-use parity.

`tests/macos_setup.py` additionally passed on 2026-09-24 against the same
installed application and selected release resources, using the current
source `setup.configure` and a disposable Codex home. It verified copied
macOS guide bytes, original MCP policy, trusted Stop/Interrupt/SubagentStop
hooks, preservation of unrelated config values, and a portable export
without upstream instruction contents. The first run exposed a `/var` versus
`/private/var` scratch-path mismatch in hook discovery; canonicalizing the
scratch path in `lcu/codex_hooks.py` fixed the failure. This setup check did
not install the browser host or exercise a provider.

The delivery implementation archive, SHA-256 `e1de6ea3ddc7e7334c597b57be1a956fc931df0d268286561304aa63b47cf580`, was installed afresh
under `/private/tmp/lcu-delivery-install`. Its packaged Python and adapter
implementation files matched the reviewed source bytes, including macOS
VS Code detection. Both scripts above passed again against this selected
release. The archive remains a development artifact: no native desktop or
Chrome action was performed and no release was published.
