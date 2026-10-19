# Installed-app loading proposal (2026-09-23)

Status: historical architecture assessment. The selected-app migration has since been implemented in the development working tree; see [current status](PARITY-STATUS.md) and [installation](INSTALLATION.md). The proposal and open questions below record the design decision at the time, not the current implementation state.

## Findings

The inspected official Linux package is `26.915.31945`, for ARM64 and x86-64. The complete application places its native computer-use runtime in `resources/cua_node`, its CLI beside it in `resources/codex`, plugin resources in `resources/plugins`, and Electron host code/assets in `resources/app.asar`. See [runtime.lock.json](../runtime.lock.json), [INVENTORY.md](INVENTORY.md), and [INSTRUCTIONS.md](INSTRUCTIONS.md). These are inspected internal interfaces, not a promise of a stable public SDK.

NanoCodex was inspected at commit `1694a2430eed3d0095c693de0928ea8552ae589c`. Its [runtime documentation](https://github.com/gakonst/nanocodex/blob/1694a2430eed3d0095c693de0928ea8552ae589c/docs/computer/upstream-provider.md) describes user-side acquisition and immutable local selection rather than shipping provider binaries in its releases. Its Linux path requires a separately installed compatible provider; automatic provisioning is documented for macOS and Windows. The [Linux installer](https://github.com/gakonst/nanocodex/blob/1694a2430eed3d0095c693de0928ea8552ae589c/scripts/install-linux-sky-host.py) accepts runtime and CLI paths, writes its own three transport files outside the upstream tree, and launches the original provider with the original Node. The [worker](https://github.com/gakonst/nanocodex/blob/1694a2430eed3d0095c693de0928ea8552ae589c/crates/experimental/nanocodex-computer/src/linux_sky_worker.mjs) imports the original service by file URL. Its supervisor separates desktop service access from model execution; this is integration code beyond importing packages.

## Proposed installation and execution

1. Discover a supported official Codex/ChatGPT Linux application installation in the environment that will run computer use. If absent, provide an explicit official installation step through the supported distribution channel. Do not obtain the payload from an LCU release or copy a macOS installation into Linux.
2. Verify platform, architecture, package identity, runtime manifest and supported source hashes. Select the matching Node, node_repl, CLI, plugins, application assets and instructions from one installation. Reject mixed or unsupported versions.
3. Install only LCU-authored launchers, registration, transport/lifecycle adapters, compatibility metadata, and tests. The model communicates through the original MCP provider, using the original policies and caller metadata. Keep desktop service privileges distinct from model execution.
4. Deliver the original instructions the way official Codex does: through the original MCP server's initialization instructions, tool descriptions and tool results. No skill is registered (changed 2026-10-01; see [instruction delivery](INSTRUCTIONS.md)).
5. Invalidate compatibility/derived caches after an app update. Do not mix a running host's old generated code with newly replaced app assets. A live read-only path alone does not guarantee version stability; upgrade coordination or a coherent user-local snapshot needs a tested design.

A Silo guest needs the Linux package inside that guest or an explicitly provisioned Linux runtime visible there. A macOS laptop's native app is not a Linux runtime. The matching Linux binaries and a graphical session are prerequisites; the complete desktop GUI need not be open for the native runtime.

## Component boundaries

| Component | Installed-app approach | Remaining work |
| --- | --- | --- |
| Native accessibility, screenshots, input, clipboard, windows, audio, persistent REPL | Launch the original provider with its installed Node, node_repl, Sky service and dependent packages. | Path discovery, session environment, original sandbox/service separation, metadata and lifecycle wiring. |
| Browser client and Chrome plugin | Resolve the unchanged packages and original extension/native-host assets from the installed resource tree. | Browser setup, account authorization and original transport still apply. |
| Original instruction files | Leave them in the installed runtime/plugins; the original server delivers them through tool descriptions and results. Remove checked-in upstream reference copies from the distributed package. | Match official Codex, which registers no skill: no skill or local references are generated (changed 2026-10-01; see [instruction delivery](INSTRUCTIONS.md)). |
| Dynamic tool and browser guidance | Let the unchanged REPL/document producers supply descriptions, schemas, guides and capability-specific documents. | Preserve host visibility/output budgets and allow the caller to receive the complete text. |
| In-app browser (IAB) | Use the original Electron runtime/assets and original provider implementation. | Current provider/auth/renderer internals are not normal public exports. The existing extractor creates exports from app.asar closures. Moving that operation to the user's machine avoids distributing generated chunks, but remains local derivation rather than simple imports. Connecting to a running official app is an alternative to investigate, not a verified drop-in solution. |
| Account, configuration, confirmations, host events | Continue using original CLI/app-server and real host service connections. | Importing packages does not create these services, grant authentication, supply consent, or enforce every agent host contract. |
| Cloud/CDP/Orbit | Load shipped client code and instructions unchanged. | Compatible external backend/service remains required; the inspected app does not supply all external providers. |

## Mixed source and repository changes

`project_instructions.py` currently verifies 195 original instruction resources and 385 byte-identical reference copies. These are filesystem resources, so loading them from the installed app is straightforward. LCU's own wrapper can remain, with paths generated at setup. Preserve full original text and dynamic selection; do not paraphrase upstream guidance.

`scripts/extract_iab_host.cjs` is different: it parses pinned app.asar JavaScript, selects dependency closures, and emits provider/bootstrap/auth/renderer modules with descriptive exports. `lcu/host_bridge.py` and `lcu/host/` supply surrounding host wiring. A pure package import cannot replace this boundary today. Local derivation should occur outside the installed app, be keyed to exact source hashes, and fail on unknown changes. Its policy permissibility is a separate question.

A migration must also audit short copied host instruction strings, generated fixtures, tests, documentation excerpts, and release assets, not only binaries. Currently `lcu/runtime.py` embeds original Eie/Die instruction strings. The dependency-loading design should obtain original text from the installed resources or original producers wherever feasible. Hashes, paths and LCU-authored integration code can remain in distribution. Previous published commits/releases are a separate distribution history; changing the next release does not erase them. Do not rewrite history or remove published assets as an incidental implementation step.

## Policy distinction and proof still needed

User-side installation removes OpenAI payload redistribution from new LCU releases. It does not independently establish permission to use private interfaces or derive exports. [OpenAI's Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/), updated January 16, 2026, restrict copying/modification/distribution and reverse engineering, subject to their qualifications, and recognize separate licences for included open-source software. NanoCodex's design is technical precedent, not evidence of OpenAI approval. Applicable component licences and authorization must be established before claiming compliance.

This proposal has been checked against source, not implemented or tested as a complete installation flow. The next technical proof is one no-redistribution loader against a clean official Linux installation, preserving complete pre-call and dynamic guidance; then a separate IAB dependency proof. Both architectures, app updates, real agent delivery and original policy outcomes need verification. Existing parity limitations remain in [PARITY-STATUS.md](PARITY-STATUS.md); changing the source location does not resolve them.

## Embedded browser versus Chrome: clarification

The embedded browser's distinctive work is mostly app integration: a task-owned browser panel, page annotation/style-feedback UI, Codex session routing, and app-specific permission/settings/OAuth services. Ordinary navigation, screenshots, page interaction and developer inspection do not inherently require that panel. The official [browser documentation](https://learn.chatgpt.com/docs/browser) describes annotations/style feedback and confirms Developer mode for both Chrome and the built-in browser; [extension documentation](https://learn.chatgpt.com/docs/chrome-extension) describes external-browser integration. Product documentation does not establish supported Linux app availability.

The pinned original Chrome and IAB guides both support temporary agent tabs, `markDeliverable`, `markHandoff`, and end-of-turn cleanup. Both also document explicit tab mentions, with different owner resolution. Thus those capabilities must not be described as embedded-browser exclusives. Chrome's original provider already handles claiming user tabs. See `instructions/browser/codex-app/tab-cleanup-{chrome,iab}.md`, `tab-mentions-iab.md`, and `tab-claiming-chrome.md`.

Silo could supply its own page feedback UI and task-to-tab integration while LCU continues using the original Chrome provider. An annotation extension would need selection/context capture, screenshots, comment delivery and lifecycle handling; equivalent user-facing functionality is a design proposal, not a completed implementation. Browser viewing can use the existing desktop viewer; an embedded browser panel would be additional UI work. Recreating Codex-owned account services or approvals is not implied by recreating a panel. Validate Chrome automation first, then decide which host features to build from concrete workflows.
