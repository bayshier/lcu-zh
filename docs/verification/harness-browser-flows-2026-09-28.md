# Harness browser flows, 2026-09-28

These tests run the actual harness UI on macOS against an isolated Linux ARM64 browser desktop. They do not prove macOS native desktop control. The task-owned macOS guest was unlocked on 2026-09-28 using its existing saved credential; OMP subsequently passed native edit/save, session approval, and fresh-process always-grant reuse. See the separate [native macOS evidence](harness-macos-flows-2026-09-28.md); Hermes has also passed native edit/save with session approval and always-grant reuse across fresh processes. The [reusable guest access procedure](macos-test-guest-access.md) records the verified login method.

The disposable containers have no network, personal home, credentials, or host desktop mounts. They run official Chrome 154.0.8037.57 with the original extension 1.26.901.11451. A verified LCU 0.4.1 archive was installed offline into a fresh prefix, reusing the image's already-installed OpenAI app 26.915.31945 and original CUA runtime 0.0.16/20260915001755-492f19756c31. Chrome retains its sandbox. A host-loopback proxy provides bounded access to `glm-5.3-flash`; the provider credential remains in the host proxy and is never copied into the harness profiles or containers.

## OMP

Official OMP [v18.4.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.4.1) passed the real model-driven flow in a fresh profile. Its interactive selector asked for the exact local origin, and PTY input selected Allow. The model used the original `cua.createBrowserTab`, filled the generated page, clicked Save draft, and verified the displayed result. The independent container oracle contained exactly `omp-browser-d115ff7bce28`; `Other.txt` was absent. An OMP `agent_end` observer fired, and the independent Chrome target inventory contained only `about:blank` before the harness process was terminated. The generated session tab therefore closed during normal turn cleanup.

The final run used the clean source snapshot at `/private/tmp/lcu-harness-latest-20260928/committed-source`, excluding unrelated working-tree changes. Private evidence is `/private/tmp/lcu-harness-full-20260928/omp-browser-evidence.json`; it records the binary, adapter, and shared-client hashes, approval observation, exact file contents, and browser targets before process shutdown. Raw transcripts can contain original runtime instructions and remain outside Git.

`tests/harness_browser_fixture.py` serves the generated local page. `tests/harness_browser_session.sh` starts the isolated Chrome fixture. `tests/omp_browser_live.py` registers the native harness plugin, runs the actual model and UI, observes turn completion, and checks the independent oracles. It accepts an explicit `--release` to test a clean source snapshot. Browser setup and extension readiness alone are not counted as a browser action.

The separate [OMP approval matrix](omp-compatibility-2026-09-28.md) covers nine real TUI decisions using a scripted provider and MCP fixture. It verifies exact scope responses, denial, and dismissal, but does not establish persistence across original-runtime restarts.

## Hermes

Official Hermes [v2026.9.24](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24), CLI 0.21.5, passed the same real browser task through its interactive `--cli` interface. The selector displayed the original local-origin request with Allow once and Deny. The model created a session tab, filled the draft, clicked Save, and read the saved state. The independent oracle contained exactly `hermes-browser-1ca114e74c34`; `Other.txt` was absent. The plugin's original `turnEnded` call completed with `Stop`, and an independent Chrome target inventory contained only two `about:blank` pages before terminating Hermes.

`tests/hermes_browser_live.py` uses fresh `HOME` and `HERMES_HOME`, the native plugin installer, the original MCP bridge, and the same local model proxy. A narrow observer in the disposable plugin copy records the successful cleanup response without replacing its execution or result handling. The browser action and tab-cleanup checks use independent container oracles. Private evidence is `/private/tmp/lcu-harness-full-20260928/hermes-browser-evidence.json`.

Hermes' separate [seven-case approval TUI matrix](hermes-harness-2026-09-28.md) uses the newer `--tui` interface and a generated MCP fixture. It checks the exact once/session/always responses, explicit denial, timeout cancellation, a session-only request, and Ctrl+C denial. The CLI and newer TUI render different menus; the tests drive each actual interface. These results verify scope selection and transport, not persistence in the original macOS runtime.

## Clean-source regression

The final source snapshot at commit `31fb398` passed `tests/run.sh linux/arm64` with the verified local app package: 199 Python tests, offline installation, agent registration, and the real original-runtime GTK suite. The packaged adapter suite passed 27 tests with 8 optional-environment skips, including the corrected Codex progress ordering tests. Unrelated working-tree changes were excluded.

Hermes repeated the browser flow from that clean snapshot and saved exact marker `hermes-browser-8545781ca719`. The actual origin selector appeared, `Stop` completed, and Chrome contained only two `about:blank` pages before process termination. Private evidence is `/private/tmp/lcu-harness-full-20260928/hermes-browser-clean-evidence.json`. The adapter source hash is `725896c2f0b5c193097c53a59745c035c48501f6e72637020250cf48b7c19452`. The final archive is `/private/tmp/lcu-harness-full-20260928/final-source/.verification/arm64.lRXwKC/lcu-0.4.1-linux-arm64.tar.gz`.

The separate [native macOS record](harness-macos-flows-2026-09-28.md) now verifies OMP actions, session approval, and always-grant reuse across fresh agent/MCP processes. Hermes has also passed native edit/save with session approval and always-grant reuse across fresh processes. The disposable guest is accessible as “LCU Verification Admin”; its access problem is resolved. Browser containers and generated MCP approval requests are not substitutes for native tests.
