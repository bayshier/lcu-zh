# Computer-audio opt-in, 2026-09-27

## Change

`lcu --audio` enables both original runtime gates, `SKY_ENABLE_AUDIO=1` and
`NODE_REPL_ENABLE_AUDIO=1`, in the child environment that starts the installed
`@oai/cua-repl` MCP launcher. `lcu setup --audio` stores that flag in Codex CLI,
Claude Code, and Pi registrations using the existing command registration path.
Portable MCP exports preserve the flag too. Without `--audio`, LCU leaves the
caller's audio environment values unchanged; if neither original flag is set,
audio stays off. The original desktop app and helper remain installed and
unchanged.

This opts into computer-audio recording through the original API. It does not
add microphone recording, an audio provider input path, a settings editor, or
new computer-use instructions.

## Original implementation and guidance evidence

The primary-source audit inspected the signed locally installed OpenAI desktop
app and its bundled CUA modules. The evidence and reproducible source identities
are recorded in [the browser/runtime audit](browser-runtime-integration-plan-2026-09-27.md#3-audio-opt-in-and-actual-audio-delivery):
`@oai/sky` exposes audio methods only when `SKY_ENABLE_AUDIO=1`, and its Mac
recording API handles approval, helper start/stop, WAV validation, and the
returned audio bytes. The original app launcher admits both flags together;
`@oai/cua` retains the original computer object. Those sources establish an
existing capture API, not a new LCU implementation.

The audit of installed app build `26.924.22138` searched the unified runtime's
static instruction files and found no feature-specific computer-audio use
guide. That finding applies to the inspected build; another app build may
change its instruction admission. Read-only inspection of the same app's main
bundle found a separate original desktop plugin-admission path: when both
flags are set, it selects the `audio` bundled-content variant for the original
`computer-use` plugin, updates that materialized skill's description, and
appends its internal audio guidance. This is app plugin materialization, not
behavior exposed by the standalone MCP launcher's `rewriteDocumentation()`.

The app-main finding comes from the selected app's
`Contents/Resources/app.asar`, member `.vite/build/main-C5425b_s.js` (SHA-256
`91a68c5f690e60033152a34cf0bf5c4234caeb9ddb47586fd3ef5b017bb29d64`), also
listed as `MAIN` in the linked audit's source table. LCU launches the original
MCP server for Codex CLI, Claude Code, and Pi; it does not start that private
desktop plugin materializer. The installed app
contains the original base `computer-use` skill, but the audio variant is
constructed by private app code. No standalone original audio guide or
supported callable admission service was found. LCU does not recreate that
generated guidance. With `--audio`, the original recording methods become
available and retain their original approval behavior, but the agent receives
no audio-specific instructions from LCU. Users continue to manage app
preferences in the installed ChatGPT app. Exact original audio-guidance parity
for the external harness registrations remains unavailable under the current
public seams.

A second, offline probe used the checksum-verified Linux ARM64 package
`26.915.31945` from `runtime.lock.json` (SHA-256
`b94c494b5f0fd7c720fa6fccd5ef609879affc62332ca930ed29b907d537bc6d`) in a
disposable container. It launched the original MCP server with both flags set,
called `tools/list`, requested `cua.rewriteDocumentation()`, and inspected the
original `cua.computer` method names. The original recorder methods appeared
(`start_audio_recording`, `stop_audio_recording`), but the emitted guide did
not mention either method. The probe made no recording call and opened no
desktop service. This confirms enabled method exposure and absent guidance for
that package only; it does not establish a live audio capture. The desktop
plugin admission path and this Linux standalone runtime are distinct. This is
not a claim that another app build cannot add standalone audio guidance.

## Disposable Linux capture

The Linux ARM64 differential harness ran with network disabled, using the
checksum-pinned package above and a source-built LCU `0.4.1` archive. It
installed the archive offline against the already prepared app. The comparison
covered original and LCU native-pipe behavior, Codex home behavior, and GUI
results. Both sides returned the generated recording as stereo 24 kHz MCP
audio with nonzero WAV bytes. The differential reported a match across 25
native GUI cases, complete MCP schemas, and delivered documentation. Its audio
assertions checked channels, rate, duration, nonzero samples, and exact MCP
audio bytes.

For an actual LCU launcher check, the same archive was installed offline at
`/opt/lcu` inside the disposable ARM64 image and launched as an unprivileged
test user with `Client(['/opt/lcu/current/bin/lcu', '--audio'])`. FFmpeg played
a local 440 Hz sine tone to a PulseAudio null sink. The original recorder
returned a 13,206-byte WAV: stereo, 24,000 Hz, 0.137 seconds, with nonzero
samples and an estimated 439 Hz tone. The temporary recording was removed
inside the container. No microphone, user audio device, network, app download,
or user credential was used. This verifies the LCU `--audio` capture path on
Linux ARM64 for the pinned package. A separate original-only amd64 probe also
captured a generated tone; no LCU amd64 capture was run.

## Output and model delivery

The original capture result can include audio bytes. Existing Codex and Pi
relays may preserve those bytes in a local audio file; Claude forwards the
original result. A saved file is local output, not audio supplied to the model.
Pi's inspected result API accepts text and images and has no audio content type.
No provider request carrying this sample as audio was established, so LCU makes
no model-audio-input claim.

## Verification boundary

Behavior/configuration tests cover paired flag propagation, default-off behavior,
caller environment preservation, and registered/exported `--audio` commands
for all three maintained clients. The Linux ARM64 differential and actual LCU
recording check above validate capture and MCP audio output for the pinned
Linux package. The current-source Darwin release also passed the original and
LCU generated-tone audio acceptance test in a disposable Apple Virtualization
guest. Neither test sent audio to a model or provider. No test touched a
personal desktop or copied credentials into fixtures.

## macOS Apple Virtualization guest acceptance

[`tests/macos_audio_acceptance.py`](../../tests/macos_audio_acceptance.py) ran
as the disposable `lcuverify` account on `VirtualMac2,1`, macOS 26.6.2 ARM64.
The selected in-place app was `/Applications/ChatGPT.app`, bundle ID
`com.openai.codex`, version `26.917.62051`, build `10789`, and CUA runtime
`0.0.16/20260915001755-492f19756c31`. Its deep strict code-signature check
passed for OpenAI Team ID `2DC432GLL2`. These are observed guest values, not
compatibility allowlists.

The test used the current-source thin release
`dist/rebuild-current-mac-20260927/lcu-0.4.1-darwin-arm64.tar.gz` (SHA-256
`0b57b8c3b8e7b2557d6e15219e22883cf0903a524bc463cecb6539daf274f9bb`). The
archive was built with the installed signed app selected in place; it contains
no ChatGPT.app or Sky helper app. The acceptance runner first read the selected
app's original audio implementation
`cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/audio_recording.js`
(SHA-256 `439d5adfb320845fab760caa449019fc9c48115b07593fb6f160be7d0ed328be`)
and declaration
`cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/types/window/StartAudioRecording.d.ts`
(SHA-256 `223888166843db29924aaa18d1955682a7614681135145a61b9dfef067a29d15`).
The original API documents loopback capture, requires the original computer-
audio approval, and accepts only `max_duration_ms`; LCU does not choose a
native input device.

The runner verified that both the original MCP process and LCU omit
`start_audio_recording` and `stop_audio_recording` with opt-in off. With the
original paired flags, it accepted one exact original audio approval and
captured a generated 440 Hz WAV played through guest `afplay`: stereo PCM16 at
24,000 Hz, 4.42 seconds, estimated 440.1 Hz. With LCU `--audio`, the same
generated-tone test accepted one original audio approval and returned stereo
PCM16 at 24,000 Hz for 4.38 seconds, estimated 434.9 Hz. Both MCP AudioContent
blocks matched their WAV bytes exactly. The runner reported `result: passed`.
Temporary tones and captures were removed when the test exited. The preserved
machine-readable result is
`/private/tmp/lcu-macos-audio-acceptance-20260927/current-build-native-results-20260927/audio-current-build.json`.

The first host-side read-only `codesign` check ran inside Codex's sandbox and
failed with `invalid signature`; the same default-context check also failed on
system TextEdit with `CSSMERR_TP_NOT_TRUSTED`. Repeating both checks with
elevated, read-only access verified the ChatGPT app and TextEdit as valid on
disk and satisfying their designated requirements. The initial failure was
therefore caused by signing-service access in the sandbox, not evidence that
the app was modified. The task-owned thin archive was built under that verified
check. It contains no ChatGPT or Sky app files; no app/helper binary was copied
or modified. The guest runner also verified the selected app in place before
recording. The standalone app recording methods are available through the
original approval path. They do not establish model/provider audio input, which
remains unverified.
