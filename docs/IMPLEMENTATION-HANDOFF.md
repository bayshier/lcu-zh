# LCU: pinned installed-app runtime and external-browser migration

> **Historical planning record (2026-09). Superseded by [AGENTS.md](https://github.com/0xpolarzero/lcu/blob/main/AGENTS.md) and [docs/INSTALLATION.md](INSTALLATION.md); do not follow its instructions.** In particular, the app-download scope described below was retired: LCU never downloads or installs the ChatGPT/Codex app and reuses the locally installed app. `.verification/...` paths cited in these records are private local evidence and are not in the repository.

This is an implementation handoff. Execute the work, validate the result, and leave a clean, usable library. Do not stop after an audit or a prototype. Keep the scope below fixed. Where a genuine dependency prevents completion, report its exact failing operation and required input; do not call discovery, matching files, or a matching failure successful browser operation.

## 1. Objective and agreed boundaries

Turn LCU into a small Linux computer-use library that installs a fixed official Codex/ChatGPT Linux application dependency during setup, then reuses that installation's original computer-use implementation and instructions. LCU releases must not contain OpenAI application binaries, runtime packages, copied instruction libraries, or generated fragments of the application.

Use an ordinary installed Chrome browser with OpenAI's original external-browser provider and official extension. Stop building or extracting a standalone copy of Codex's embedded browser UI. Preserve the complete applicable Linux-native implementation and external-browser interfaces, configuration, instructions, policy and lifecycle behavior. Do not replace the upstream automation engine with Playwright, Selenium, a custom CDP server, or a home-grown accessibility/input implementation.

The new finish line is native Linux computer use plus working external-browser control, delivered to supported agents through the original runtime. This is an explicit scope change from recreating every Codex application feature. The embedded Codex browser panel, its private account/workspace UI, cloud/Orbit backend provisioning, and a Silo annotation/style-editing extension are not required for this library release. Preserve the upstream installation intact, including its other code and documents, but do not claim those unconnected providers work. Do not silently substitute another browser for a user's requested browser.

Useful browser features already supplied by the Chrome provider must remain: tab discovery and claiming, explicit tab mentions, navigation and interaction, screenshots/page inspection, supported developer APIs, temporary tabs, deliverable/handoff markers, and turn cleanup. A capability is available only when the actual provider advertises it and policy permits it.

Do not build a desktop environment, VM manager, remote viewer, authentication service, browser engine, or general plugin framework. LCU controls an existing Linux desktop; Silo or another host supplies the VM and viewing experience. A Mac installation cannot supply Linux executables to a guest.

## 2. Orchestration and working rules

You are the orchestrator. Maintain the dependency graph, concrete acceptance criteria and integration state. Delegate bounded work with explicit file ownership and proof requirements. Keep the main context focused on decisions, interfaces, failures and results rather than whole source dumps.

- Default to fresh `gpt-6-luna` agents with `medium` reasoning. Use `low` for mechanical inventories or documentation cleanup and `high` for bounded analysis that warrants it.
- Escalate a concrete difficult protocol, sandbox, authentication or lifecycle problem to `gpt-6-sol` with `high` reasoning when Luna has isolated the issue and needs deeper reasoning. Do not start all work on Sol.
- Use `gpt-6-astra` for a specifically identified hard problem or one final independent review. Supply evidence and a focused review request; avoid repeated expensive review loops.
- Parallelize independent work up to the available tool limit. Prefer two or three useful workstreams over agents competing for the same files. Do not assume a particular concurrency limit.
- Each agent receives the objective, owned files, relevant sources, forbidden scope, acceptance tests and reporting format. Require a short result: changed files, evidence, failure retained, remaining blocker. Stop or redirect drifting agents promptly.
- The orchestrator owns shared configuration/interfaces, integration commits and final decisions. Give agents non-overlapping files; integrate shared-file edits sequentially. No surprise dependency/version changes.
- Build a minimal vertical slice first, then harden it. Delete dead code once its replacement is demonstrated. No speculative abstractions, broad refactors, new service frameworks or duplicated upstream implementations.
- Use direct work on `main`, as requested. Do not create a draft PR. Preserve unrelated changes, untracked files and earlier failing evidence. Do not reset, clean, force-push, or delete published history/assets as routine cleanup.
- Use isolated desktops, homes and browser profiles. Never test on the user's personal desktop, copy their credentials into fixtures, print tokens, change their normal approval settings, or disable a sandbox to make a test pass.
- Keep progress updates short and meaningful. Ask only for missing decisions or external inputs that actually block work. Continue independent authorized work while waiting. Do not request approval again for already authorized changes.

Suggested waves:

| Wave | Parallel assignments | Orchestrator responsibility |
| --- | --- | --- |
| A: establish the seam | Luna: pinned app provisioning/relocation; Luna: external-browser action/auth path; Luna if capacity permits: instruction/host-contract migration inventory | Capture repository state, resolve exact install contract, review evidence and freeze shared path/config interfaces |
| B: implement | Luna: installer and failure recovery; Luna: native launch/session/service wiring; Luna: instruction generation/agent registration | Own shared installation descriptor, integrate walking skeleton; escalate only a reproduced hard problem |
| C: finish browser and delete obsolete code | Luna: external-browser integration; Luna: negative/failure/architecture tests; Luna: docs and packaging cleanup | Control deletions against the new dependency graph; prevent browser UI scope creep |
| D: verify and ship | Independent ARM64/x86-64 validation jobs; bounded review agent | Review all results, fix material findings, inspect artifact/history contents, publish only after gates pass |

Do not wait until the end to attempt a real authenticated browser action. That is the largest unproven prerequisite.

## 3. Current state and primary evidence

Repository: `/Users/polarzero/code/projects/lcu`, remote `https://github.com/0xpolarzero/lcu`. Reinspect state rather than trusting this snapshot blindly.

At handoff preparation, local `main` is `95189d0` and is one commit ahead of `origin/main` (`d1d9f96`). There are uncommitted CODEX_HOME implementation/tests/docs and untracked `docs/INSTALLED-APP-DESIGN.md`, `docs/PARITY-REVIEW-2026-09-22.md`, and `tests/codex_home.py`. Preserve the review file and do not sweep it into a commit. The existing draft PR is `https://github.com/0xpolarzero/lcu/pull/1`; the user requested direct main work instead. Inspect its current state before closing it, without posting an unsolicited comment.

The local unpublished commit contains the older complete-copy approach. Do not push it blindly merely to synchronize main. Inspect the outgoing commit range for newly introduced upstream payloads, including files deleted by later commits. If task-owned unpublished commits need consolidation to avoid publishing that material, preserve a local backup first and keep unrelated work intact. Do not rewrite published history. Earlier public releases/history require separate explicit cleanup decisions; a clean new artifact does not erase them.

The user explicitly approved restoring upstream CODEX_HOME selection/trust. That approval concerns LCU's child environment, not editing the actual user's Codex configuration. Review the unfinished change: explicit CODEX_HOME stays verbatim, default selection mirrors Node's Linux `os.homedir()` plus `path.join`, and empty trust entries are omitted. Eleven focused runtime unit tests passed during the latest work; the new native service trust fixture did not complete validation before the architecture changed. Do not inherit an unearned integration-pass claim.

Read these existing sources before replacing them:

- `AGENTS.md`, `runtime.lock.json`, `docs/INSTALLED-APP-DESIGN.md`.
- `scripts/install.py`, `scripts/install.sh`, `lcu/runtime.py`, `lcu/session.py` if present, `lcu/setup.py`, `lcu/browser.py`, and `bin/`.
- `docs/INSTRUCTIONS.md`, `docs/INVENTORY.md`, `docs/HOST-CONFIG-PARITY.md`, `docs/STANDALONE-ADAPTATIONS.md`.
- `docs/BROWSER-HOST-PARITY.md`, `docs/BROWSER-DEPENDENCIES.md`, `docs/PARITY-STATUS.md`.
- Existing native, browser, installer, agent-delivery and lifecycle tests. Reuse behavior fixtures rather than writing a second automation stack.

The old AGENTS.md requirement to bundle upstream at build time conflicts with this new instruction. Update it and the affected docs to the new install-time acquisition model. Keep its useful requirements for original code, both architectures, policy preservation and real integration tests.

### Fixed dependency

Use the already inspected package, not an unreviewed latest release:

```text
Codex/ChatGPT Linux app: 26.915.31945
CUA runtime: 0.0.16/20260915001755-492f19756c31
Source template:
https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.915.31945_{deb_arch}.deb

arm64 SHA-256:
b94c494b5f0fd7c720fa6fccd5ef609879affc62332ca930ed29b907d537bc6d

amd64 SHA-256:
d27a9c02919cfe484dcc5f34584b9ea9fd0d7a65c69dcc872b5bdcfa0efb5983
```

`runtime.lock.json` should remain the single machine-readable source of truth. Use matching bundled Node, node_repl, Codex CLI, modules and plugin assets from this one app generation. Keep package identity separate from the CLI's own version. Do not spoof versions or mix a system CLI with a different runtime to conceal incompatibility.

Previously verified packages are cached locally at `/private/tmp/silo-cua-engine.yy0cvD/chatgpt_arm64.deb` and `/private/tmp/cual-build.XHmjSz/chatgpt_amd64.deb`; treat these as optional development caches and verify their hashes. Never make release/install behavior depend on these paths. Do not modify the original comparison tree `/private/tmp/lcu-iab-prototype/usr/lib/chatgpt`.

NanoCodex reference, inspected at commit `1694a2430eed3d0095c693de0928ea8552ae589c`:

- [Installed upstream provider](https://github.com/gakonst/nanocodex/blob/1694a2430eed3d0095c693de0928ea8552ae589c/docs/computer/upstream-provider.md).
- [Linux installer](https://github.com/gakonst/nanocodex/blob/1694a2430eed3d0095c693de0928ea8552ae589c/scripts/install-linux-sky-host.py).
- [Linux service worker](https://github.com/gakonst/nanocodex/blob/1694a2430eed3d0095c693de0928ea8552ae589c/crates/experimental/nanocodex-computer/src/linux_sky_worker.mjs).

Its Linux path requires an already supplied runtime and adds a desktop-service transport adapter; it does not automatically acquire the Linux app. Use it as engineering precedent, not proof that our authentication, permissions or complete workflow works. If reusing its code, verify its applicable licence and retain attribution.

Google's current [installation documentation](https://support.google.com/chrome/answer/95346?co=GENIE.Platform%3DDesktop&hl=en) lists Linux ARM64 as well as x86-64 packages. Do not repeat the old assumption that Linux Chrome cannot run on ARM64. Actual compatibility between the chosen browser, extension and pinned provider still requires a test.

## 4. Gate A: prove the install and browser architecture

Before the broad migration, reproduce three things in disposable Linux environments:

1. The full, untouched fixed app payload can be installed in a private versioned location and its matching runtime/CLI/services can execute as the desktop user with normal OS sandboxing.
2. An ordinary browser with the official extension/native host can connect through that installation and complete at least one actual authenticated action, observed independently by a fixture page.
3. An agent can receive the original tool descriptions and read complete original instructions before its first computer-use call from a locally generated skill registration.

Native operation is already demonstrated against this package; authenticated external-browser actions are not. A successful `tools/list`, browser inventory, matching auth error or low-level test-mode call does not pass item 2. Identify the official sign-in path and exact required account/host inputs. Use an explicitly authorized test account/session; do not harvest a personal credential file. If external input is unavailable, retain the failing evidence, request that specific input, and continue independent work. Do not claim the browser finish line is achieved.

Inspect official package metadata and maintainer scripts without executing them casually. The inspected ARM64 `.deb` post-install script configures an OpenAI apt repository/key and loads an AppArmor profile. Therefore an ordinary system package installation has update/security-integration side effects. Do not assume raw extraction is equivalent to `apt install`, and do not disable AppArmor or browser sandboxes to avoid missing installation integration.

Recommended default: provision the **complete official application as a private, versioned dependency under LCU's managed prefix**, with its original files intact, rather than downgrading or globally holding the user's system app. Describe this honestly as a managed application installation, not a system package-manager installation. Validate relocation and required security integration first. The actual executable chain must run under normal Ubuntu security settings; demonstrate that any required AppArmor profile applies to its real relocated path. Do not require launching unrelated app UI just to pass this library gate. If private installation fails because of an upstream security/installation requirement, retain the precise failure and report the options before switching to a system installation. Continue unaffected work, but do not silently overwrite the user's app, add its update repository, weaken confinement, or change system-wide policy.

## 5. Installer and dependency ownership

Implement a short, explicit install sequence:

1. Validate arguments, Linux OS/architecture, supported distribution prerequisites and target desktop account before modifying configuration.
2. Select an already verified managed app installation, an explicitly supplied exact compatible installation, or download the fixed official package directly from OpenAI. A local pinned package must also support offline setup.
3. Download into staging; verify the exact hash before extraction/execution. Check package architecture/version, runtime manifest, necessary executables, links, permissions and dependency identity. Preserve upstream notices. SHA pinning is an integrity check; do not call it signature verification unless you actually verify a signature against an independently established key.
4. Provision the app and required system libraries before attempting runtime-based agent registration. Validate as the intended unprivileged account. Promote the complete installation atomically; never select a partial download or half-written tree.
5. Generate LCU's installation descriptor, instruction references and agent registrations from that selected installation. Configure the original browser native host for the desktop account. Report any required extension enablement or sign-in clearly.
6. Run appropriate readiness checks. Distinguish installed, desktop-ready, browser-discovered and browser-action-ready states.

Use one immutable app generation per version/architecture/digest, reused across LCU upgrades and agent sessions. Keep writable profiles, socket state and generated per-user native-host configuration outside it. Do not duplicate the app once per agent or once per task. A shared installed dependency is not shared browser authentication or sandbox isolation.

Reuse the existing versioned-release/atomic-current mechanism where it fits. Define rollback precisely: failed LCU/app selection leaves the previous working selection usable; system library installation is not a fully reversible transaction and must not be described as one. Coordinate concurrent setup, interrupted downloads, cache corruption, running processes, upgrades and uninstall. Old live generations must not disappear underneath a process. Do not invent a background updater or garbage-collection daemon.

Support Ubuntu 24.04-compatible glibc Linux ARM64 and x86-64 with the existing X11/D-Bus requirements first. Other distributions can use documented preprovisioned dependencies if verified; do not promise arbitrary Linux, musl, or native Wayland support. The app/runtime executes in the Linux guest or server, not the macOS host.

Preserve the useful existing installer contract: `--prefix`, `--user`, repeatable `--agent`, `all`/`auto`, `--scope`, `--project`, `--session discover|direct`, `--export`, `--check-desktop`, `--runtime-only`, `--skip-system`, `--yes`, `--list-agents`, and the legacy positional prefix. Preserve configuration unrelated to LCU and drop root privileges before account-specific writes. Retain original supported agent IDs and aliases.

Add only necessary options, such as an explicit existing app path, a local official package path and strict offline mode. Choose names once and document them; build-time `--package` did not previously mean installer input. `--skip-system` skips system provisioning, not dependency acquisition; document the changed network model. Strict offline mode must fail without a valid cached/supplied package and must make no acquisition network calls. Browser/model services can still require network access during use.

Retire IAB-only options (`--browser-host`, `--with-browser-host`, private IAB serve/protocol commands) deliberately: give an actionable migration error during the transition if needed; never silently reinterpret them as Chrome approval or launch settings. Do not preserve an unused embedded host merely to keep those options nominally accepted.

## 6. Runtime, services and host contract

Centralize resolution of paths from the selected application; remove assumptions that OpenAI files live inside the LCU release. The inspected app has `resources/cua_node`, `resources/codex`, `resources/codex-code-mode-host` and `resources/plugins`. Check actual files instead of trusting a path string alone.

Launch the original `@oai/cua-repl` entrypoint using the app's Node and node_repl. Preserve its persistent execution, reset, image/audio output, error/recovery behavior, trusted services and upstream configuration options. Preserve the original sandbox/approval boundary. A privileged desktop service may require host transport, as NanoCodex demonstrates, but that is a narrowly scoped bridge to the original service, not permission to expose privileged APIs to ordinary model JavaScript.

Do not add a second environment filter without source-backed evidence: the agent host's child environment selection and LCU's direct-launch environment are separate layers. Preserve explicit caller settings and document necessary standalone defaults. Keep real model/turn/session metadata, connection ownership and lifecycle signals authentic. Do not fabricate an account, model identity, feature rollout, approval response or successful authorization.

Complete and test the already approved CODEX_HOME behavior using isolated fixtures, including empty/relative/whitespace values and default HOME normalization. Trust only the intended upstream-selected home/module roots and explicit adapter needs. Do not make broad new directory trust changes incidentally.

Retain applicable original tool visibility, startup timeout, output allowance and lifecycle behavior. The pinned Codex contract exposes model-facing `js`/`js_reset`, reserves `turn_ended` for lifecycle and does not expose module-directory injection indiscriminately. Discover the exact contract from installed resources. Generic MCP registration alone cannot enforce every host feature; retain an explicit portable contract and demonstrate delivery rather than claiming identical behavior in every agent.

## 7. Instructions without redistribution or condensation

> Superseded on 2026-10-01: official Codex computer use registers no skill and delivers the full guide in the first tool result, so LCU now registers no skill and generates no pre-call references. See [instruction delivery](INSTRUCTIONS.md).

Keep upstream instruction code/resources in their installed app locations. Remove the checked-in copies under `instructions/` and `skills/lcu/references/` from the new distribution once local delivery replaces them. The existing inventory has 195 original instruction resources and 385 reference copies; use that inventory as a completeness baseline, not as permission to ship the copies again.

At setup, generate a small LCU-owned wrapper with full pre-call access to the original guides through stable local references/symlinks. If a supported agent cannot follow them, create byte-identical user-local reference files from the selected app during setup. Never put those generated upstream copies in Git, release assets, CI uploads, published container layers, or a portable export advertised as redistributable. Bind generated references to the selected app version and regenerate them coherently on upgrade.

The agent must be able to read the full guide before its first API call. Do not replace it with a summary or rely solely on a blind bootstrap call. Preserve the original first-call and post-reset/compaction instruction delivery, dynamic browser capability filtering, confirmation guidance and alternate-mode documents. Shared cross-platform source files may remain shared; label their applicability without editing original prose. Keep evidenced standalone notes separate, including Linux `getApp` using an observed window ID and use of the already initialized `cua.computer` client where applicable.

Audit original strings embedded in LCU's own code, not only markdown. `lcu/runtime.py` currently copies the original browser/Chrome use-case descriptions. `scripts/extract_iab_host.cjs` also embeds the original `is-copilot-api-available` function body in `copilotServiceSource`; removing the obsolete IAB path must remove this literal and its generated outputs too, after verifying that external-browser operation does not depend on them. Obtain required text through the installed original producer/resources or a narrowly justified local reader; do not silently drop effective instructions. Record every standalone adaptation and source provenance. Protocol method names and paths are integration identifiers; distinguish them from copied implementation/prose.

Update portable exports so they resolve/provision the dependency at the destination and carry LCU-authored bootstrap/contract metadata, not a hidden copy of OpenAI files. Cross-machine exports must not assume the producer's absolute paths exist elsewhere.

## 8. External browser implementation

Use the existing original Chrome plugin/native messaging installer and provider from the installed app. Retain necessary per-user writable native-host configuration; the current installer writes beside its executable, so a local verified copy of that plugin may be needed outside the immutable app. It must originate from the local app at setup and never be redistributed in our artifact.

Reuse an explicitly selected compatible browser/profile. If the target environment has no browser, provide a clear supported installation path and validate that clean path on both architectures. Do not silently repurpose the user's personal profile, change default browser/protocol associations, auto-accept extension permissions, or distribute private signed-in profiles. Use the official extension installation/enablement route; distinguish reproducible test extension packaging from the supported production setup.

Record actual browser and extension versions used for validation. The Codex app stays fixed; do not freeze browser security updates globally or claim future Chrome/extension versions automatically work. Detect unsupported combinations or connection failure clearly.

Prove the full chain: original MCP provider → original browser service → original native messaging host/extension → selected browser → observable page result. Keep all real authentication, site policy, confirmation and host-service dependencies. If the browser still needs an official app-server/account connection, preserve or implement that minimal connection without rebuilding the embedded UI. Do not assume the desktop GUI must be running, or that it need not be; establish the actual dependency with a real test.

Use the Chrome provider's existing tab claiming, mentions, cleanup, handoff and deliverable behavior. Do not reimplement features it already supplies. Preserve unknown-tab/session rejection and reconnect behavior. A crashed or timed-out operation with uncertain effects must not be automatically replayed.

Host experience for this release: humans view/use the same sandbox browser through the existing desktop viewer; agents use the original provider. Add only the small task/tab mapping or external-open handoff needed by that contract. Do not create a new browser window system.

Optional later feature, explicitly outside this release: a Silo/browser extension for element/region annotations, screenshots, comments and visual style previews. That would be our interface, not copied Codex UI. It needs a separate accepted use case and tests for selection alignment, page changes, context delivery and ownership. Do not scaffold it now, invent a feedback framework, or treat it as a missing runtime capability.

## 9. Aggressive cleanup after proof

Once the external-browser walking skeleton passes, remove the obsolete embedded-browser implementation and all exclusively supporting material. Candidates include `scripts/extract_iab_host.cjs`, generated IAB providers/renderer shims, `lcu/host/`, IAB-only parts of `host_bridge.py` and `protocol.py`, browser-host CLI flags, IAB-specific tests, build projection code, stale package inventories and old full-bundle release machinery. Trace imports before deleting: keep a small shared app-server transport if the external browser or registration still needs it.

Remove vendored OpenAI code/instructions from the distributable source tree and new releases. Keep compact lockfiles, hashes, original source locations, LCU-authored adapters, meaningful tests and concise provenance. Replace old inventories with the smallest checks that prove the selected dependency and relevant instructions are intact; do not make each LCU release carry enormous application inventories unless an actual integrity requirement justifies them.

Rewrite current README/install/development/status docs around the resulting architecture. Remove stale bundled-runtime, no-install-download and complete-IAB-parity claims. Preserve concise historical failures and provenance where useful; do not keep contradictory old documents as current guidance. Update skills and all commands to paths that actually work.

Audit release scripts, source archives, Python/JS packages, agent exports and container recipes for accidentally reintroduced upstream files. A public image with a locally downloaded OpenAI app baked into a layer still redistributes that app; publish a bootstrap recipe or clean image that acquires it on the end user's machine instead. Local private test images are separate from release assets.

Delete obsolete code, not valuable unrelated work or evidence of unresolved failures. No remote force-push, purge of old release assets, global credential cleanup or VM deletion without specific authorization.

## 10. Verification and acceptance matrix

Use the same behavior fixtures against the untouched official dependency and the LCU launch path. The original baseline must assemble inputs independently; do not make both sides call LCU helpers. Confirm independent application outcomes rather than comparing our snapshots to themselves.

| Area | Required evidence |
| --- | --- |
| Clean install | Thin LCU artifact acquires exactly the fixed official app before runtime-dependent setup; matching native services start as the selected user |
| Reuse/offline | Repeat install reuses verified app; valid supplied/cached package works with network blocked; absent or corrupt cache fails before selection changes |
| Failure/upgrade | Wrong version/arch/hash, interrupted acquisition, staging failure, concurrent install, permission/symlink conflicts and failed validation preserve the previous usable selection |
| User state | Existing Codex app, unrelated agent config, profiles, defaults and approval settings remain intact; root setup writes account files with correct ownership |
| Native behavior | Accessibility and coordinate actions, independent text/file/clipboard outcomes, screenshots, window/app operations, keyboard/mouse/scroll/drag, persistence/reset/recovery, and supported audio paths |
| Trust and sandbox | Selected-home trusted service works, outside-root negative control is rejected, original restrictions remain effective; ordinary-user runs on actual Linux OS policy, not only privileged containers |
| Chrome success | Authenticated page navigation, independent click/type/form state, screenshot/page inspection, actual advertised accessibility/API behavior, user-tab claiming and exact tab targeting |
| Chrome lifecycle/failures | Turn cleanup/deliverable/handoff semantics; reset; browser/extension/service restart; auth expiry/denial; inaccessible or wrong-session tabs; unsupported capability; no unintended replay after uncertain failure |
| Instructions | Complete pre-call files match original bytes; original initialization/tools/descriptions and selected-browser documents arrive intact; reset/compaction replay works; no summaries substituted |
| Agent delivery | All advertised installers/scopes/config-preservation tests pass; an actual pinned Codex CLI exercises visibility/output/lifecycle, plus an independent MCP consumer exercises the documented portable contract |
| Distribution | Published source/artifacts/exports contain only LCU-owned code and legitimately redistributable dependencies/metadata; no OpenAI payloads, instruction copies, tokens, profiles or generated app chunks |

Run on Linux ARM64 and x86-64. Record whether execution is native or emulated; previous x86-64 runs used emulation on Apple Silicon. Emulated results are useful but are not native-hardware evidence. Obtain native x86-64 CI/host coverage before claiming native x86-64 validation. Do not infer reliability on all agents, applications or desktop environments from a bounded suite.

Reuse existing deterministic GTK/X11/socket/HTTP/audio fixtures. Test with ordinary desktop users and normal sandbox settings; privileged containers or `--no-sandbox` are not production proof. Include an Ubuntu VM check where required OS policy is absent from containers. Preserve failure logs before retries. Hash the exact artifact/source and record command, environment, browser/extension version, fixture outcome and limitations.

Keep offline fixture gates separate from explicit live-account tests. Missing authorized credentials are a blocker to the corresponding live claim, not a reason to inject a fake approval or report an auth failure as success. Scripted-model Codex tests prove agent-facing delivery for that fixture, not general model reliability. Do not invent per-session isolation for OS-global resources such as the desktop clipboard; assert the upstream contract actually guarantees.

Run focused checks during development, then one full required matrix for the exact final artifact. Repeat broader checks only for changes or unresolved failures that warrant it. A final review must assess both specification compliance and implementation quality, separately.

## 11. Completion, release and final report

The work is complete only when:

1. A new supported Linux environment can install LCU through the documented API, with the fixed official app provisioned first and reused thereafter.
2. Native computer use and authenticated external-browser actions work through original implementations with the declared policies and lifecycle behavior.
3. Full applicable original instructions reach agents before and during use, without redistributing them in our releases.
4. The required architecture, installation, failure, agent-delivery and distribution gates pass, with honest coverage labels.
5. The embedded-browser reconstruction and other obsolete code are gone from the active library; current docs and CLI describe one coherent architecture.
6. No known in-scope feature is missing or falsely marked complete. External or out-of-scope dependencies are explicitly listed.

After those gates, follow the user's existing instruction to publish directly to `main` and make a release using the cleaned artifact. Inspect repository release conventions and choose the appropriate version for the changed installation contract. Close the obsolete draft PR if still open; do not create another. Do not publish a release with known in-scope blockers merely to satisfy a deadline.

Provide a concise final report with the commit and release URL, exact dependency version, tested architectures/browser versions, working commands, removed code, meaningful test evidence, and any remaining limitations. Never claim universal identical Codex reliability. If blocked, provide completed work, the exact failing operation, preserved evidence and the smallest missing external input. Continue useful independent work before stopping.

Policy statement: eliminating payload redistribution is the engineering objective, not a blanket claim of OpenAI approval. Check applicable component licences/terms and do not use NanoCodex as proof of permission. Preserve original authorization boundaries. The previous [architecture assessment](INSTALLED-APP-DESIGN.md) links the relevant primary sources; resolve any actual permission blocker rather than disguising local extraction or copied code as a normal import.
