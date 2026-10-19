# Disposable macOS guest recovery and acceptance status, 2026-09-28

The isolated Apple Virtualization guest runs macOS 26.6.2 on arm64. It uses
the existing signed ChatGPT app in place: bundle `com.openai.codex`, observed
version `26.917.62051`, build `10789`, signature identifier
`com.openai.codex`, team `2DC432GLL2`; signature verification passed. The
observed CUA runtime is `0.0.16`. No official app or native helper was copied,
modified, or re-signed. UTM management and all feature tests were confined to
this disposable guest; the user's desktop was not used.

The original local test account and data remain intact. Recovery's supported
password reset requested the old password, which was unavailable. Apple's
Recovery `resetpassword` flow also returned “Failed to deactivate device.”
Neither path was repeated; no disk data was erased or manually edited. A
separate local verification account was created through the documented
offline `dscl -f … localonly` interface and logged in normally. Apple Account
sign-in was skipped, analytics stayed disabled, Siri was disabled, and
FileVault remained unchanged. No account credential or private access locator
is recorded here.

The current-source audio acceptance measured a generated 440 Hz tone at
440.1 Hz through the original API and 434.9 Hz through LCU. Both returned
audio streams matched their captured bytes, and no provider request occurred.
The historical archive used for that run had SHA-256
`0b57b8c3b8e7b2557d6e15219e22883cf0903a524bc463cecb6539daf274f9bb`.

An earlier source-frozen Stop diagnostic archive (`7cc10bf29ab5012231ff0fc6aaa4b6fed952427ac4ced97cc8d2c186d17659af`)
was not accepted as final evidence: although Stop between native calls
returned the original stopped-for-this-turn response, its fresh-turn recovery
oracle failed. The current-source archive used by the later between-call run
had SHA-256
`10021a5f83f26c70a99493d412aad6312b630e9b0626558164c3c30e58e12b6e`.
That run accepted AppStop for `com.apple.TextEdit`, returned the original
stopped-for-this-turn response on the next action, and completed a fresh-turn
TextEdit save whose file bytes matched the expected content. It did not stop
an in-flight native MCP request.

A separate pending-call attempt exceeded its time budget while generated
TextEdit input continued, so it produced no valid result and is not treated as
a pass or failure. The diagnostic shell was fetched but not executed. No
personal credentials, app binaries, or helper files entered the fixture.
Final current-source Stop and Pi acceptance status is recorded in the
[headless Stop implementation record](headless-stop-implementation-2026-09-27.md).
