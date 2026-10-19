# macOS Unicode text input

## Scope and observed baseline

Two app versions are involved. The contributor's source and native inspection, and the baseline readbacks below, were on ChatGPT 26.1007.21159, CUA runtime `0.0.29/20261005054403-144090e2ddcb`, macOS arm64 and Node 24.21.0. The maintainer's live calls ran on ChatGPT 26.1007.30912 (see Live results). These are observations, not compatibility gates.

Earlier direct field readbacks on an ordinary Chromium textarea showed native `typeText("LCU: 한글 입력 테스트 가나다 ABC 123")` losing the Korean, with ASCII, digits and spaces retained. The existing original paste path delivered the complete mixed-script string in three trials. Those observations motivate this adaptation; they do not constitute a live test of the patched runtime.

## Official-source evidence

All inspected files remain in the original signed application. No OpenAI source fragment or binary is copied into this repository.

- `cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js` dispatches the requested original client method and arguments.
- `targets/mac/type_text.js` invokes `withComputerUsePolicy` for `type_text` and passes `app` and `text` to the original Mac client.
- `targets/mac/client.js`, `MacComputerUseClient.typeText`, forwards the complete `text` in the native `type` action. Its request serialization removes undefined values, not non-ASCII text. No Korean filtering or ASCII encoding was found in this JavaScript path.
- `targets/mac/paste.js` invokes the original app-policy/approval wrapper for `paste`; the same original client sends the text and format in its native paste action.
- The original macOS API guide states that app paste restores the previous clipboard contents.

The JavaScript transport therefore delivers the complete string. The loss occurs in the signed native helper, as established below (upstream [openai/codex#27494](https://github.com/openai/codex/issues/27494)). The LCU fix reuses the working original input methods instead of changing or re-signing the application.

## Native root cause

The inspected helper is `Codex Computer Use.app` (`com.openai.sky.CUAService`, observed 26.1005.1001425, build 1001425, signature valid). Its symbol table and disassembly were read in place. Nothing was copied, modified or re-signed, and no code or binary fragment is reproduced here.

- The perform-action IPC handler calls `ComputerUseAppController.performKeyboardAction`, whose typing case calls `SynthesizedEvent.type(string:)`. That function holds the only reference to `+[SAIVirtualKeyPress keyPressesForString:]`. Paste and key presses build their key presses without it.
- `keyPressesForString:` reads the current keyboard layout (`TISCopyCurrentKeyboardLayoutInputSource`, its Unicode key layout data and `LMGetKbdType`) and walks the string one UTF-16 code unit at a time, mapping a line feed to a carriage return. For each unit it searches eight modifier combinations of Shift, Option and Control across virtual key codes 0-127 with `UCKeyTranslate`, looking for a key whose output starts with that unit.
- A unit with no matching key is logged as `Could not find key code for character: <c>` and skipped. The method fails only when the layout itself cannot be read, and only that failure raises the helper's key-translation error. A partial result is typed without an error, which is why the call reports success.
- Each surviving key press becomes key-down and key-up events that carry its key code, modifier flags and matched Unicode string, posted to the target process. The event path can carry arbitrary Unicode. The characters are lost earlier, in the layout lookup.

On the inspected standard Korean, ABC and US layouts, precomposed Korean syllables come from input-method composition rather than the output of one key, so every syllable is skipped. Other characters, including UTF-16 surrogate units, are skipped whenever the active layout has no matching key output.

**Runtime evidence.** The macOS unified log of the helper process holds that message for every dropped syllable of the earlier observations: ten typing calls between 11:31:42 and 11:44:56 on 2026-10-12 (the reporter's local time), each logging exactly `한글입력테스트가나다`. The first two match the recorded TextEdit and Chromium readbacks.

```sh
log show --last 3h --predicate 'process == "SkyComputerUseService" AND eventMessage CONTAINS "Could not find key code"'
```

**Model evidence.** Repeating the same lookup through the public Carbon calls, outside the helper and without posting an event, yields `LCU:     ABC 123` for the test string on the 2-Set, 3-Set, 390 and romaja Korean layouts and on ABC and US. The lost set depends on the active layout: ABC and US reach curly quotes, dashes and some symbols through Option, the 2-Set layout does not, and the Russian and Greek layouts have no key for ASCII letters.

## Routing

`lcu/macos_sky_service.mjs` adapts only a macOS `type_text` request whose first argument is plain data and whose text has a code point above 127. The text is split at control characters (`/[\x00-\x1f\x7f]+/`):

- Control runs, such as `\n`, `\t` and `\r\n`, go to the original `type_text`, so they act as keys.
- Each chunk between control characters goes whole to the original `paste` with `format: "text"` if it contains a code point above 127, otherwise to `type_text`. Adjacent typed chunks form one request.
- A grapheme cluster never spans a control character, so surrogate pairs, emoji sequences and combining marks are never split. A lone surrogate is passed on unchanged inside its pasted chunk, as the original would receive it.

Each segment keeps the caller's input descriptors and any further arguments, with only `text` replaced (and the format added for paste). For example, `2024년 3월 15일 오후 3시` is one paste; `안녕 ñ\n` becomes paste `안녕 ñ` then type `\n`; `é1\tñ2` becomes paste `é1`, type `\t`, paste `ñ2`.

Segments are sent strictly in order, each through the existing dispatch with its own stale-service recovery. The original native-pipe startup error is raised while the transport connects, before that segment's action is written, so its single retry resends only that segment. Segmented requests run one at a time, so two concurrent ones never interleave. Any error stops the sequence and propagates: there is no lossy fallback to typing and no retry of earlier segments. When the request's own turn ends (Stop or Interrupt), no further segment is sent. Another turn ending, such as a subagent's, does not stop it, except that a stale-service retry is refused after any turn end, as for every request; the next segment first waits for that turn's native cleanup, as a new request would. Without turn metadata any turn end stops it. The result is the last segment's, which, like each original method's, is `undefined`. ASCII, empty text, explicit `paste`, setup and malformed or accessor inputs remain one unchanged original request. Input and request objects are never mutated.

Each segment goes through the original app policy and approval request. With once-scoped approvals each segment asks again, and declining a later one stops after the text already delivered. Session or always approvals (what Claude's lcu-approve offers) are per app, so they ask once.

## Live run of the patched wrapper (2026-10-12)

About 12:03-12:09 CEST. The patched wrapper from commit a7bd3eb ran from a throwaway copy of installed LCU 0.11.2 (`cp -R` of the release; only `lcu/macos_sky_service.mjs` differed, its SHA-256 matching the commit, and `app` still linked to `/Applications/ChatGPT.app`) on ChatGPT 26.1007.30912, CUA 0.0.29, helper 26.1005.1001425, French AZERTY. The harness was headless Claude Code (`claude -p`) with an MCP configuration identical to the user's LCU registration except for the prefix, and the user's existing turn hooks. Safari is always allowed and TextEdit is not, so only Safari was tested. The fixture was a local page whose field event logs were sent to a local server. The original high-level `typeText` was called and the wrapper did the routing.

All results were as expected:

- Chat textarea, `안녕 ñ\n`: one paste then Enter; submitted once with `안녕 ñ`.
- Single-line input in a form, `2024년 3월 15일 오후 3시 abc\n`: one paste then Enter; the form was submitted once with the exact text.
- `é1\tñ2`: Tab moved focus; the fields read `é1` and `ñ2`.
- React-like controlled input, `Hello 😀 wörld 한글`: exact, with `insertFromPaste` input events.
- Contenteditable, ``LCU: 한글 입력 OK\nñü ^~` fin\tend😀 é``: the text up to `fin` was exact, Enter made a real paragraph, and Tab moved focus to the next field, where `end😀 é` landed.
- Pure ASCII, ``plain ascii ^~`'"``: typed as `keydown`/`insertText` with no paste and no dead-key corruption.
- A typed `X` after each step landed at the caret.
- Eight pastes in total; `\n` and `\t` always arrived as Enter and Tab `keydown`s.
- The helper log had no `Could not find key code` line in the interval.
- The clipboard `changeCount` rose by exactly 16 (one write and one restore per paste), with no write after the run. Byte identity was not proven in this run, because another process wrote to the clipboard after the "before" snapshot; the earlier ten-segment run below proved it.

## Live results with the earlier split (2026-10-12)

ChatGPT 26.1007.30912, helper 26.1005.1001425, macOS with the French AZERTY layout, about 11:00-11:10 CEST. The calls were made by hand, through LCU's `js` tool (installed LCU 0.11.2), calling the original `typeText` and `paste` in routed order, and checked by field readback in TextEdit, Safari (textarea, single-line input inside a form, contenteditable, a React-like controlled input and a password field) and VS Code. The wrapper itself was not involved.

These calls used an earlier, finer split, in which ASCII inside a line was typed and only the non-ASCII runs were pasted. The current rule pastes whole chunks that contain such characters; its call order was checked live in Safari only, in the run above. The key-semantics results below hold under both rules, since control characters are typed under both.

- Original typing dropped `ñ` on AZERTY, as it drops Korean and emoji. `ü`, a dead-key character on AZERTY, is modelled, not observed.
- Whole-text paste breaks key semantics: `안녕 ñ\n` in a chat textarea kept the newline and did not submit; `한글 abc\n` in a single-line input did not submit its form; `é1\tñ2` put a literal tab in the first field instead of acting as a key.
- Routed calls were exact in every target and submitted once. Tab acted as a real key: focus moved in Safari, and VS Code inserted its configured indentation. Pasted runs fired input events (`insertFromPaste`).
- The password field dropped `ñ` when typed and accepted the paste.
- Dead-key ASCII (`^`, `` ` ``, `~`, `'`, `"`) was typed as the right keys in TextEdit, Safari and VS Code, with nothing left pending. TextEdit's own smart quotes and autocapitalisation altered its readback.
- Clipboard restoration is the original's. After ten alternating type/paste segments the restored data was byte-identical, but its type order changed. The original skips restoration if anything else wrote to the pasteboard in that window. The pasted text was visible on the clipboard for about 35-170 ms (about 2 s in VS Code and in the paste-blocked field), with no transient markers and a momentary empty pasteboard.
- Cost: about 150-200 ms per pasted run (about 2 s in VS Code and in the paste-blocked field) against about 15 ms of typing.
- Paste into a paste-blocking field silently inserts nothing, with no error.
- Terminal cannot be targeted: the original runtime refuses `getApp("Terminal")` for safety reasons, so neither path was tested there.

## Limits

The wrapper does not inspect the keyboard layout, so "code point above 127" approximates "the active layout has no key for it".

- Characters the active layout can type are pasted as well when they share a chunk with a character above U+007F, and so is the ASCII in that chunk. They still arrive, with paste semantics and cost.
- Only segmented requests are serialized. A concurrent unsegmented request from another agent (`type_text`, `paste`, `press_key`, a click) can land between two segments. The original had no such window, because one `type_text` was one native action.
- Non-Latin layouts and input methods are not handled. On a layout without Latin letters the original typing path drops ASCII letters, and the wrapper does not route them. This gap is modelled with the Russian layout, not observed live.

## Automated regression evidence

`tests/node/macos_unicode.test.mjs` exercises the actual wrapper against a hand-made original-service stand-in, not an OpenAI code copy. The stand-in models the observed unmapped-character typing loss and Unicode-preserving paste. Its twenty-one tests cover: one paste for a line with unmapped characters, including `2024년 3월 15일 오후 3시`; control characters kept as typed keys (`안녕 ñ\n`, `é1\tñ2`, `한글 abc\n`, CRLF, blank lines); emoji sequences and combining marks; a lone surrogate passed on unchanged; further arguments kept on every segment; one unchanged request for ASCII and empty text; approval denial on the first segment sending nothing and a later denial stopping the sequence; a paste failure mid-sequence stopping without a typing fallback or resend; a stale-service failure (the exact original startup error, with an in-memory recovery answer) retrying only the failed segment, and stopping the sequence when nothing recovers; the request's own turn end stopping the remaining segments while another turn's end does not (another session, or another turn of the same session as a Claude subagent's), the next segment waiting for that other turn's native cleanup acknowledgement, and any turn end stopping them without turn metadata; concurrent segmented requests not interleaving, with an error not blocking the next; setup and explicit paste; immutable frozen requests; accessor inputs left to original validation without invoking the getter; and non-enumerable `app`/`text` descriptors.

```sh
node --test tests/node/macos_unicode.test.mjs
node --check lcu/macos_sky_service.mjs
```

## Guest-free original-JS integration

`tests/node/macos_unicode_original.test.mjs` imports the selected installed application's original Sky service, Mac client, policy code and native-pipe frame codecs in place. The test intercepts only `nodeRepl.nativePipe.createConnection` with an in-memory endpoint; it rejects any other endpoint and forbids real application launch. It uses an invented fixture app identity, simulated app-policy responses and fixture-only approval callbacks. Analytics are disabled. No real native service, desktop app or clipboard is contacted or granted access, and no OpenAI source is copied into Git.

On the observed macOS app/runtime pair, ten original-JS integration checks passed. They establish:

- Unpatched original JS serializes the complete mixed Korean string into native `type`; Unicode is not lost in its JavaScript transport.
- The patched wrapper sends a line with unmapped characters as one native `paste` (exact Unicode text, plain-text format) through the original approval with the policy-normalized fixture target.
- ASCII remains one original native `type` action.
- Return and Tab between pasted chunks are separate native `type` actions (`안녕 ñ\n`, `é1\tñ2`, `한글 abc\n`). This confirms dispatch, not a real application's submission behavior.
- The original asks the host for approval on every segment. With a modelled host that remembers a session approval per app, the user is asked once; with once-scoped approvals, once per segment; declining a later one leaves only the earlier segments delivered.
- Original organization-policy denial and user approval refusal on the first segment prevent all native input actions.
- A native paste error returned by the fake endpoint propagates through the original error classes, after the earlier typed segment, with no typing retry and no later segment.

```sh
LCU_TEST_ORIGINAL_MAC_APP=/Applications/ChatGPT.app node --test tests/node/macos_unicode.test.mjs tests/node/macos_unicode_original.test.mjs
```

Without the explicit app environment variable, the original-JS integration checks skip with a reason. Their passing result must not be reported as live native-helper/UI verification. The stale-service retry is covered by the wrapper tests only, because the original startup error needs a real connection timeout. The native keyboard-loss log was independently re-read for the earlier 11:31:40-11:45:00 interval (the reporter's local time): 100 messages, each of `한글입력테스트가나다` appearing ten times, with first/last timestamps matching the recorded baseline. The IPC-only tests cannot create a new helper-log oracle because they intentionally do not contact that helper.

## Unverified boundaries

The patched wrapper ran live in Safari only. TextEdit, VS Code and the password field were checked only with the earlier, finer split, by hand through `js`. Clipboard byte identity was proven only in that earlier run. App-policy denial and once-scoped approval prompts were not exercised live. Non-Latin layouts and IMEs are modelled, not observed. No new Linux or Windows verification is claimed. The helper's log is a second oracle: a passing run leaves no `Could not find key code` message in the test interval. Other typing clients must not share that interval, since the message alone has no per-request attribution.

## Removal criterion

No per-pair switch exists today. Re-test on the app/runtime pair in use by calling the original `typeText` directly through `js` with the routed strings (mixed Korean/ASCII, emoji, combining marks and `ñ` on AZERTY) and independent field readback, as the 2026-10-12 run did. When the unadapted helper preserves them, delete the routing and its tests and record the pair here. If a per-pair switch is wanted before then, it must be added as a `native_input` value in [tested-versions.json](../../tested-versions.json) that `lcu/tested.mjs` accepts and the Sky wrapper honours, as the Linux one is.
