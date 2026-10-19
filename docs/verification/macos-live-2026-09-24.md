# macOS live native check, 2026-09-24

The user explicitly authorized a test on this personal laptop for this session, overriding the repository's default prohibition on personal-desktop testing. No original application code, instructions, API, or policy was changed.

## Installed path and result

The test used the thin development archive SHA-256 `e1de6ea3ddc7e7334c597b57be1a956fc931df0d268286561304aa63b47cf580`, selected under `/private/tmp/lcu-delivery-install/current`, with signed `/Applications/ChatGPT.app` 26.917.62051 and CUA 0.0.16/20260915001755-492f19756c31. A disposable Node harness imported the packaged `adapters/client.mjs`; that shared SDK client launched the selected original MCP server. CODEX_HOME was empty and isolated. Native macOS HOME remained the real desktop account so the original helper socket could be found.

Through that standalone connection, the original `cua.getApp("com.apple.TextEdit")` selected TextEdit. The test clicked New Document, typed a Unicode marker, received the expected accessibility text and screenshot, opened the Save dialog, selected a temporary directory, and saved an RTF file. A separate `textutil -convert txt -stdout` read verified the expected file content. The same original app binding persisted across the calls. The original `turn_ended` hook returned successfully before connection close.

The original provider requested MCP app approvals for TextEdit operations. The test client accepted only the explicit test requests for that app; it did not alter the provider or grant general app access. This confirms approval delivery as well as UI control. It does not establish that every harness caches app decisions the way Codex does.

## Observed limitation and cleanup

A subsequent `pressKey("super+w")` did not close the test document. The returned tree showed the same window with its text empty and modified. A later built-in Codex observation confirmed that state. The marker was restored and saved using the built-in original tool, and its visible close button closed the test document. The surviving TextEdit Open panel contained no open test document. The final file content was checked again.

The original JavaScript forwards the exact key string to the compiled native helper. A later direct-original comparison confirmed this acted as Undo in both original CUA and LCU on this French-keyboard machine. The visible source does not establish the native keyboard-layout cause. No keyboard workaround or engine change was added. See [macos-cold-and-keyboard-2026-09-24.md](macos-cold-and-keyboard-2026-09-24.md).

Ghostty was not used: the built-in Computer Use tool explicitly refused it for safety reasons, and that restriction was respected.

## Remaining checks

The original CUAService socket already existed before this run. Success establishes control through the existing signed helper and existing OS permissions. It does not prove startup without an existing helper, operation with the Codex UI closed, or the first OS-permission experience. No existing helper was terminated.

Chrome 153.0.8010.53 had no connected official extension. Original native-host setup succeeded under a disposable HOME, without writing a personal native-host registration. A separate temporary Chrome process was stopped after verifying its executable and test-only profile path because the native app binding selected the regular Chrome instance. Through Chrome's normal UI, a signed-out profile named `LCU disposable test` was then created. The official ChatGPT 1.26.901.11451 Web Store listing was reached, and the extension installation permission dialog is pending user approval. No extension was installed and no Chrome action through LCU is claimed.

Private raw responses and the screenshot remain only in `/private/tmp/lcu-macos-live-no7mz5ya`; they are not repository or release payload. The test document is `/private/tmp/lcu-macos-live-no7mz5ya/LCU native saved.rtf`. Browser fixtures and generated host files also stay under that temporary directory. Windows remains unimplemented.
