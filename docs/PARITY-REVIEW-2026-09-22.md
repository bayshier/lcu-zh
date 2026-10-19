# Linux runtime and instruction parity review

> **Historical planning record (2026-09-22). Superseded by [AGENTS.md](https://github.com/0xpolarzero/lcu/blob/main/AGENTS.md) and [docs/INSTALLATION.md](INSTALLATION.md); do not follow its instructions.** The `.verification/...` paths cited below are private local evidence and are not in the repository.

Reviewed 2026-09-22 by three independent agents covering runtime, instructions, and reliability, plus a separate review of the official application host.

**Verdict: LCU v0.2.1 preserves the selected native Linux desktop engine, but does not contain all Linux-relevant runtime surfaces or establish equivalent agent reliability.** The review found concrete omissions and one reproducible initialization failure in a nondefault documentation mode. The focused native comparison passed.

This review applies to commit `d1d9f9699180348ad51971073a378c3a52ce16a6` and its existing release archives. No runtime, installer, instruction, release, or agent configuration was changed during this review.

## Baseline and sources

- Official package `26.915.31945`; embedded runtime `0.0.16/20260915001755-492f19756c31`. Package URLs, versions and checksums are recorded in [PROVENANCE.md](PROVENANCE.md).
- [Official ARM64 package](https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.915.31945_arm64.deb): SHA-256 `b94c494b5f0fd7c720fa6fccd5ef609879affc62332ca930ed29b907d537bc6d`.
- [Official x86-64 package](https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.915.31945_amd64.deb): SHA-256 `d27a9c02919cfe484dcc5f34584b9ea9fd0d7a65c69dcc872b5bdcfa0efb5983`.
- Reviewed LCU ARM64 archive SHA-256: `fd619f2a23cfb937bf414c9d4c309a3a9520651915d468cd644c4d9053dcddd3`.
- Reviewed LCU x86-64 archive SHA-256: `5fdb59b0cc4a1d0f7daea4ce759af98bb11f5ed7c38a4f1044c9370329df87e2`.

The [official Linux application documentation](https://learn.chatgpt.com/docs/linux/linux-app#compatibility-and-limitations), checked on the review date, says Computer Use is not yet available in the Linux preview. The package contains working Linux engine code. Those are different claims. The new behavioral comparison below uses the shipped upstream runtime directly, not a running Codex application or agent. Earlier descriptions of a usable engine must not be read as verified product availability or product reliability.

Unless stated otherwise, upstream paths below are relative to `usr/lib/chatgpt/resources/cua_node/lib/node_modules` in the pinned package.

## Findings

### 1. High: Linux browser functionality and instructions were removed

[scripts/project_runtime.py](../scripts/project_runtime.py), lines 55–65, disables browser initialization, inventory and instruction selection. Lines 83–88 classify browser dependencies alongside non-Linux engines. [lcu/runtime.py](../lcu/runtime.py), line 20, forces the computer-only surface.

The excluded surface is Linux-relevant. Evidence includes:

- `@oai/cua-repl/instructions/linux/browser.md` and `linux/browser-cloud.md`, including the CDP browser.
- `@oai/cua/docs/tinysky-alt-other-browser-apis.md`.
- `@oai/cua/dist/lib/js/oai_js_browser/dist/skill/references/api.json`, `documents.json`, and capability-selected upload and troubleshooting guidance.
- `@oai/browser-desktop/scripts/browser-service.mjs`, which contains Linux browser discovery and native-messaging paths.

LCU therefore lacks original browser/tab selection, browser accessibility, and browser-specific input. Controlling a browser as a native X11 window does not reproduce those APIs. This is a proven scope omission, not a failure of native window actions.

Required correction: inventory each Linux browser backend and its service requirements, then retain the applicable original implementations and documentation. Classify unavailable application-host services such as the in-app browser separately. Merely enabling the surface flag is insufficient.

### 2. High: Codex host configuration is outside the current parity checks

The official package's `usr/lib/chatgpt/resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json` specifies:

| Setting | Official plugin value |
| --- | --- |
| Enabled tools | `js`, `js_reset`, `turn_ended` |
| Omitted routing | `code_mode`, `deferred` |
| Startup timeout | 120 seconds |
| `js` output token limit | 25,000 |

[lcu/setup.py](../lcu/setup.py), lines 233–238 and 276, registers the command and arguments through the generic installer/export without these settings. [tests/integration.py](../tests/integration.py), line 19, explicitly expects the additional raw server tool `js_add_node_module_dir`. Both runtimes expose that raw tool; Codex's plugin configuration filters it.

The official application also supplies selected trusted services, module paths, request metadata, model-check settings and the Codex CLI path when applicable. LCU preserves some caller-provided settings but does not reproduce this host integration. Host-controlled output limits, tool selection, policies and instruction delivery are part of the agent's observed behavior.

This is a demonstrated configuration difference and a missing test boundary. No output-truncation failure or sandbox escape was observed or claimed. A standalone package cannot assume every supported agent implements Codex's host behavior.

Required correction: document and test the supported host contract, reproduce applicable settings for Codex registration, and explicitly identify behavior that another agent host must supply. Test what the agent actually receives, in addition to raw MCP responses.

### 3. Medium: Public Linux imports were removed

[scripts/project_runtime.py](../scripts/project_runtime.py), lines 66–69, retains only `@oai/sky/service` and `@oai/cua/tinyskyAlt`. The original packages also export their root entrypoints.

An executed resolver comparison succeeded for original `@oai/sky` and `@oai/cua`; both release copies returned `ERR_PACKAGE_PATH_NOT_EXPORTED`. Consequently, the upstream Linux skill's `import { sky } from "@oai/sky"` cannot run unchanged. Binding `sky = cua.computer` retains the native client methods but is an avoidable public API divergence.

Required correction: preserve applicable original Linux entrypoints and test the original bootstrap examples.

### 4. Medium: A retained documentation selector points to an absent guide

[docs/INSTRUCTIONS.md](INSTRUCTIONS.md), line 9, incorrectly says `cua.initialize()` is absent. Both upstream and the released bundle expose the `initialize: getState` alias. The bundle also retains `TINYSKY_ALT_INITIALIZE_DOCS`, but omits `tinysky-alt-core-node-repl.md`.

A no-GUI probe imported the actual released JavaScript with a stub Sky setup service:

| Selected mode | Observed result |
| --- | --- |
| `core-cua-repl` | Initialization succeeds; `cua.initialize` is a function |
| `core-node-repl` | `ENOENT` for `docs/tinysky-alt-core-node-repl.md` |

The default mode is unaffected. A host that passes the selector through the REPL environment allowlist can trigger the failure.

Required correction: retain supported alternate guides or explicitly reject unsupported modes, and correct the exclusion rationale. Do not describe a retained API as absent.

### 5. Medium: Linux runtime options are discarded

[lcu/runtime.py](../lcu/runtime.py), lines 12–15, removes `OAI_SKY_CONFIG_PATH`. Original `sky_js/src/load_options.js` reads it. The Linux implementation uses options including `post_action_sleep_ms` and `mouse_size_px`; `targets/linux/action_settler.js` defaults to 100 ms.

A caller's configured upstream action settling or cursor rendering cannot be reproduced through the normal LCU launcher. No claim is made that the reviewed Codex host sets nondefault values.

Required correction: preserve or explicitly expose validated Linux configuration, and compare launches under matching options.

### 6. Medium: Completeness and reliability tests have gaps

[scripts/project_instructions.py](../scripts/project_instructions.py) validates the 12 selected ledger inputs. It cannot detect an unlisted relevant resource. Current integration tests compare delivered text with the selected repository projection and do not execute an upstream baseline. This protects selected content from drift but does not prove complete source selection.

The default XFCE discovery path has only process-fixture coverage. Current two-window tests use one client sequentially, not simultaneous agents. Representative browser/Electron/Qt applications, real session discovery, application launch/dialog lifecycle, and policy delivery through an actual agent host remain unverified.

Optional Linux audio code remains present, but upstream requires `pactl`, `ffmpeg` and a Pulse-compatible monitor. The installer does not provision those optional prerequisites, and audio was not tested.

Required correction: inventory all instruction producers and resources with explicit dispositions, fail on unclassified additions, and add differential tests plus documented capability prerequisites.

## Evidence that passed

- The runtime reviewer independently verified byte identity of the released ARM64 Node, Node REPL and Sky native binaries against the pinned official package.
- Both projected CUA and Sky build manifests retain all 22 original Linux target JavaScript modules, including settling, IDs, transport recovery, screenshots, input, launch and optional audio.
- A deterministic facade probe produced identical original/projected API inventories and 13 identical RPC calls. It used a fake trusted Linux service; it does not establish native reliability.
- The instruction reviewer ran the source projection against pristine ARM64 and x86-64 extracts successfully. Applicable native workflow rules are preserved in the selected default guide. The Linux desktop skill body is preserved except its front matter and client binding.
- Excluding `sky-full-desktop-api.md` loses no substantive Linux guidance: the retained Linux skill covers the same declarations and adds guidance. The excluded window API guides explicitly target macOS and Windows.
- A new offline ARM64 comparison ran original upstream and LCU v0.2.1 in the same Ubuntu 24.04/Xvfb/Openbox/D-Bus/GTK fixture. Both exposed the same native method set, scrolled to the same independently measured position, produced matching drag and drag-handle press/release endpoints, returned matching filtered accessibility trees, and emitted full-desktop JPEGs.

The final scroll value was `190.406562472419` in both runs. Pointer-motion counts and JPEG lengths varied and were not asserted identical. The probe used a shared fixture sequentially with scroll reset; it did not establish repeatability across independent sessions. It did not run on x86-64, in real XFCE, through the Codex app host, or through an agent model. No native projection regression was observed on these tested paths.

## Reproduction and retained evidence

Local review evidence is retained under ignored `.verification/parity-review-2026-09-22/`:

- `reliability/`: probe, fixture, original-runtime launcher, comparator, result JSON, and run log. `python3 compare.py` validates the captured outcomes.
- `runtime/`: resolver probe, facade/RPC probe, and matching original/projected JSON.
- `instructions/`: runnable missing-guide reproduction and captured output. Run `python3 reproduce.py /absolute/path/to/lcu-0.2.1-linux-arm64.tar.gz` with Node 24 available; this imports unchanged bundle JavaScript with a fake setup service, not the native REPL or a GUI.
- `host/`: ASAR inspection script, source hashes/offsets, excerpts and the official plugin descriptor. These were extracted from the pinned official package, not a user's running app or credentials.

The inspected ASAR files are `.vite/build/main-DUHZj4_w.js` (SHA-256 `9e8a3bd79c817064f28693ca26aa1378895e07ab2108c78c42d0ea20dac9d66e`) and `.vite/build/src-C3YaUE83.js` (SHA-256 `14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472`). Relevant symbols are `So` (surface selection), `Sne` (plugin launch configuration), `kie` (runtime environment), and `nne` (REPL server configuration). In this build, `So` gates the unified native computer surface to Darwin. This supports the distinction between shipped Linux runtime code and a Linux product baseline.

The behavioral probe ran in a disposable `--rm --network none` ARM64 container using `cual-test:arm64`. No personal desktop or copied credentials participated. Existing two-architecture standalone verification remains recorded in [VERIFICATION.md](VERIFICATION.md); it is distinct from this new ARM64 differential evidence.

## Acceptance criteria before a parity claim

1. Classify every upstream Linux runtime surface, public entrypoint, instruction source and dynamic document; resolve the omissions above with explicit host-dependent exceptions.
2. Run the same independent behavior oracles against untouched upstream and LCU in fresh matching desktops on both architectures, including configuration, initialization modes, recovery, launch/dialog lifecycle and concurrency.
3. Verify actual registered-client instruction delivery, tool filtering, output budget and policy propagation. Add a product-host comparison only when a supported Linux product baseline exists.

Even a passing finite suite supports measured behavioral equivalence within its coverage, not a universal guarantee of identical agent reliability. The next implementation step is to restore the applicable omitted Linux surfaces and make the upstream comparison a release requirement.
