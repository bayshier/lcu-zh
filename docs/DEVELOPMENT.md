# Development and validation

LCU releases are thin platform/architecture-specific Linux and macOS tarballs. A Windows candidate ZIP can be built separately; Windows remains deferred from the current delivery. The official app is never part of an archive and must already be installed before setup. Local app selection checks official identity/signature where applicable, supported architecture, runtime manifest, required files, and recognized host layout; it records the observed app and runtime versions instead of requiring repository app-version or component-hash allowlists. macOS uses the signed installed app in place. Linux selects an installed app by runtime manifest, architecture and structure, and uses it in place. The URL and checksums in [runtime.lock.json](../runtime.lock.json) are retained for separate development/test package inputs and do not authorize installer downloads. Windows selects the registered official Store app and records a source-derived inventory for its private copy.

## Building from source

Use the [release installation guide](INSTALLATION.md) unless you are changing LCU. Build on the target OS and architecture with Python 3.12+ and Node 22.15 or later; the build tooling and test drivers stay Python and are never shipped, and the release itself runs only on the app's Node. Users need no Python on any platform. macOS also requires a compatible official app, `npm` and `swiftc` (Xcode Command Line Tools), which compiles and ad-hoc signs LCU's own `bin/lcu-owner-auth` helper for [`lcu apps`](INSTALLATION.md#manage-approved-apps); Linux builds provision their own pinned Node dependency. Dependency downloads need network access during the build. The official app is never downloaded by the builder.

Clone the repository and read its version:

~~~sh
git clone https://github.com/amontlabs/lcu.git
cd lcu
LCU_VERSION=$(node --input-type=module -e "console.log((await import('./scripts/bundle.mjs')).VERSION)")
~~~

On Apple Silicon macOS:

~~~sh
python3 scripts/build_bundle.py --platform darwin --app /Applications/ChatGPT.app --output dist
tar -xzf "dist/lcu-$LCU_VERSION-darwin-arm64.tar.gz" -C dist
cd "dist/lcu-$LCU_VERSION-darwin-arm64"
~~~

On Linux ARM64 or x86-64:

~~~sh
LCU_ARCH=$(node --input-type=module -e "console.log((await import('./scripts/bundle.mjs')).architecture())")
python3 scripts/build_bundle.py --platform linux --output dist
tar -xzf "dist/lcu-$LCU_VERSION-linux-$LCU_ARCH.tar.gz" -C dist
cd "dist/lcu-$LCU_VERSION-linux-$LCU_ARCH"
~~~

`scripts/bundle.mjs` holds the release version (`VERSION`); `scripts/build_bundle.py` reads it from there. From the extracted directory, follow the [macOS](INSTALLATION.md#macos) or [Linux](INSTALLATION.md#linux) installation steps. The source checkout has no sealed bundle manifest and cannot be installed directly. Rebuilding the same version requires a fresh output directory, such as `dist/rebuild-1`; generated archives stay under `dist/` and out of Git.

The builder creates a tarball and SHA-256 sidecar. It provisions the fixed third-party agent registration tools and links their Node executable to the application that setup selects later. It does not download or extract the OpenAI app. Build-time `--package` is retired. Install the official app separately, then pass its installed Linux directory with `--existing-app PATH` only when it is outside `/usr/lib/chatgpt`.

The deferred Windows x64 candidate ZIP is built with `python3 scripts/build_bundle.py --platform windows --output dist`. It contains no OpenAI payload. Its entry point is `scripts/install.ps1`, which runs the Store app's own `node.exe` (or a temporary copy of it) on `scripts/install_windows.mjs`. Direct execution from the protected WindowsApps tree returned Access denied, and the original sandboxed Node REPL could not spawn the native helper directly. The installer stages an intact copy of the registered Store-signed application, records and checks its source-derived inventory, and first checks, read-only and before the copy, that the app's native-pipe host factory can be located by structure (reporting the failed check and the observed app version), then extracts that factory and its exact dependencies outside that sandbox ([layout and vendored parser](PROVENANCE.md)). One install runs at a time per prefix (a lock), and a copy this run created is removed if a later step fails unless a release already records it. It does not use the inspected package version or component hashes as compatibility gates. Earlier installed candidates, built with the Python 0.9.x installer, in a disposable Windows 11 guest initialized the original MCP, listed a live Notepad window, and saved exact Unicode text to an existing file with an independent byte oracle. A matching Stop and Interrupt each removed the native helper; a stale Stop left a newer turn's helper running, and MCP shutdown removed the final helper. These observations establish installed native action and lifetime behavior for the Python 0.9.x installer, not a Windows Chrome or model-driven task. The Node installer (`install.ps1` with `install_windows.mjs`) has no live Windows run yet; its Windows coverage is unit tests and structural checks only. The [live Windows record](verification/windows-source.md) gives the guest boundaries.

Claude Code registration on Windows does not supply original per-turn cleanup. Its documented [`Stop` hook](https://code.claude.com/docs/en/hooks) excludes user interruption, while `StopFailure` covers API errors and `SessionEnd` fires only when the session ends. Until a supported ordinary-CLI interruption event and matching turn metadata are validated, use Pi or a compatible Codex CLI for Windows native work that needs automatic per-turn helper cleanup; the same recommendation applies to optional Chrome temporary-tab cleanup.

Linux and macOS archives include the same shared MCP SDK client and Pi extension. The macOS archive adds app resolution, signature validation, installation dispatch and native turn-cleanup wiring. Selection reads actual app/runtime metadata and supports the legacy and current recognized Codex tool locations; supported architecture remains Apple Silicon. The builder uses the verified app's Node and the host's npm CLI to install locked registration and adapter dependencies. It does not install or alter the app.

Run adapter checks with `npm test --prefix adapters`. [Mac runtime verification](verification/macos-runtime.md) distinguishes transport/instruction checks from live native control. A sandbox that prevents `codesign` reading signing services or prohibits nested `sandbox-exec` cannot perform those checks; preserve original sandbox settings and run verification in an appropriate host environment.

Before publishing, inspect the tar member list and unpacked tree. They must contain LCU-owned launchers, lock/installer metadata and redistributable registration dependencies only. They must not contain app binaries, upstream instruction copies, generated app fragments, profiles or tokens. Portable exports have the same no-OpenAI-payload requirement.

## Tested version record

[tested-versions.json](../tested-versions.json) lists the app and CUA runtime pairs that checked-in verification covers; [tested app versions](INSTALLATION.md#tested-app-versions) describes how LCU reports it. It is informational and is never used to select or refuse an app. Add an entry only after the pair itself passed: for Linux, `tests/run.sh` against that package on both architectures, with the package's SHA-256 as `app_sha256`; for macOS, the installed-app and desktop checks in the release notes. Set `lcu_version` to the release whose gates covered it, point `evidence` at the release notes or verification record, and never record a pair that only installed. An entry may also list `"native_input": ["gtk4", "qt-scroll"]` for the Linux toolkits whose window-targeted input that exact pair handles natively, which turns off [LCU's input translation](STANDALONE-ADAPTATIONS.md#linux-window-targeted-input-reason-and-removal-criterion) for those toolkits on that pair; add it only after the gates passed with the translation off. `tests/node/tested.test.mjs` checks that every entry is well formed, unique and points at an existing file. Workarounds for upstream OpenAI defects, each with its exact removal criterion, are listed in [UPSTREAM-WORKAROUNDS.md](UPSTREAM-WORKAROUNDS.md); re-check them when recording a new pair.

## Release severity marker

`lcu update` notices can say how urgent a release is. Add one of these HTML comments to `docs/releases/<version>.md`, on a line of its own:

~~~md
<!-- lcu-severity: security -->
<!-- lcu-severity: breaking -->
~~~

`lcu update --check` and the background refresh fetch that file for the latest release tag and read the marker. The notice is then prefixed "Security update:" or "Breaking update:". The marker must be on a line of its own; a mention inside other text is ignored, so notes can describe the syntax safely. Without a marker, or with any other value, the notice has no prefix. The marker must be in the notes file at the release tag, because that is the copy that is fetched; a later edit on main is not seen for an already tagged release.

## Thanking outside contributors

When someone outside the maintainers reports an issue that leads to a change, opens a PR, or finds a bug in review, the release that first ships that work thanks them by GitHub handle for what they actually did. When a change comes from an outside report, its PR body links the issue and thanks the person, and the commit carries a `Reported-by: Name (@handle)` trailer so release time can find it. Squash-merge an outside PR with the contributor as commit author (GitHub's default), and keep `Reported-by:` only if they also reported the problem. To collect names, look through the commits since the previous release tag for authors who are not maintainers, `Reported-by:` and `Co-authored-by:` trailers, and the issues and PRs those commits link. Thank each outside contributor briefly inline where their work is described, as `(thanks @handle)` or appended to that bullet's links, for example:

~~~md
([#123](https://github.com/amontlabs/lcu/issues/123), [#124](https://github.com/amontlabs/lcu/pull/124), thanks @handle)
~~~

Past release notes are not edited to add credit.

## Install and exercise an isolated fixture

Prepare a disposable Ubuntu 24.04-compatible Linux desktop and account. A test may use a verified local official .deb as input, but extract it into the disposable fixture before invoking LCU:

~~~sh
mkdir -p /absolute/test-app-root
dpkg-deb --extract /absolute/chatgpt.deb /absolute/test-app-root
./scripts/install.sh --prefix /absolute/test-prefix --user testuser --skip-system --existing-app /absolute/test-app-root/usr/lib/chatgpt --offline --runtime-only --yes
/absolute/test-prefix/current/bin/lcu doctor
~~~

Root is required only for apt and another account's setup; the target app/REPL must be exercised as that unprivileged desktop account. Use an isolated HOME, CODEX_HOME, X11 session and browser profile. Keep the untouched original package baseline independent of LCU helpers, then compare observable GTK/X11/file/clipboard outcomes. Do not count a matching failure, tools/list, browser inventory or extension discovery as a successful browser action.

Run `tests/run.sh` and focused checks inside disposable containers. Besides the writable-extraction gate (`tests/offline.sh`), it runs `tests/offline-readonly.sh`: the package's app is copied into a Docker volume that is mounted read-only at two `/opt/silo/chatgpt/<version>` folders, LCU is installed with `--existing-app` at the first, the GTK desktop suite runs as the target account, and a reinstall at the second path must follow it. The volume is removed afterward. `tests/offline.sh` also hides every `python3` in the container behind a failing shim, reinstalls, and runs the installed `lcu`, `lcu-session`, `lcu-codex-sandbox`, `doctor`, `status` and a setup export; any Python call fails the gate. The image keeps `python3` only for the test drivers and fixtures. For focused checks during implementation, run these in the container:

~~~sh
node --test tests/node/*.test.mjs       # LCU's own modules, one test file per module
python3 -m unittest discover -b -s tests -p 'test_*.py'   # build tooling, Claude plugin, Hermes plugin
npm test --prefix adapters
~~~

Node 22 does not take a directory for `node --test`; name the files as above. Tests of POSIX-only behaviour (sh launchers, file modes, symlinks, accounts) skip themselves on Windows with the reason (`posixTests` and `posixOnly` in `tests/node/fixtures.mjs`).

The Python test drivers (`tests/*.py`) treat LCU as a black box: they run `lcu`, `lcu-session` or the installer. Where one needs an LCU helper itself, such as the harness registration `lcu setup` performs, it calls the `lcu/*.mjs` export through Node with `tests/lcu_node.py` (`LCU_MODULE_ROOT` selects an installed release instead of the checkout).

### End-to-end checks against 0.9.7

`tests/e2e/run.sh [CHECK...]` builds (or reuses, with `--old-archive`/`--new-archive`) the 0.9.7 release and this tree, runs each in fresh sandboxes with a disposable account and a fake app made of recorder scripts, and compares parsed data, never output text: the files `lcu setup` writes for every agent and scope (`setup`), exit codes of commands, usage errors and the installer (`exit`), the original runtime's launch command and environment (`launch`), an upgrade with 0.9.7's own `lcu update` and a rollback (`upgrade`), install, setup and launch with every Python blocked (`nopython`), and the startup budget (`startup`: each entry point's median at most 10% + 5 ms above 0.9.7's). Run it as root (or with passwordless sudo) for the disposable accounts; `--self-test` checks that the harness catches planted differences. The only expected rename it accepts is the Chrome relay, `lcu-native-host.py` → `lcu-native-host.mjs` (`EXPECTED_RENAMES` in `tests/e2e/e2e.py`). The only expected addition it accepts is `cross_turn` in `lcu status --json`, and only with its default value `{"enabled": false, "source": null}` (`EXPECTED_ADDITIONS`). After `lcu update`, and after the rollback (a `--runtime-only` reinstall of 0.9.7, which does not rerun setup), the Claude Code `lcu-approve` mod in HOME must equal the copy shipped in the NEW archive, because `lcu update` refreshes it; the upgrade check also confirms that 0.9.7 still provides what that mod calls (the relay's `approval_request` and `approval_choice` tools, `lcu update --notice --json --announce`, `lcu apps --json`).

LCU 0.9.7's `lcu update` runs the new archive's `scripts/install.py` (`install_macos.py`, `install_windows.py` on Windows) with its own Python. Those three files stay in the archive as stubs without logic that hand over to `install.sh` (or `install.ps1`) with the same arguments.

Narrow `node --test` to one file, such as `tests/node/runtime.test.mjs`, while iterating.

GitHub Actions (`.github/workflows/ci.yml`) runs the Node tests on Linux, macOS and Windows under Node 22.15 (the minimum) and 24 (what the app ships), the build-tooling and adapter tests on the same three systems, the end-to-end checks with the startup budget on amd64 and arm64, builds the Windows archive natively, runs lint (bug-class ruff for the Python tooling, shellcheck, `node --check` for every `.mjs` and `.cjs`, `sh -n` for the extensionless launchers) and `scripts/check_archive.py` on freshly built Linux and Windows archives for every push and pull request. Windows unit tests are not live Windows desktop evidence. `tests/run.sh` runs natively on amd64 and arm64 for pull requests to main and nightly (`.github/workflows/linux-gate.yml`); its `.verification/` output holds official app files and is never uploaded. CI does not replace real macOS or Windows desktop evidence.

The final gate must test both architectures, mark emulation explicitly, and run native and Chrome actions under a normal Ubuntu host policy outside a privileged container. Inspect the actual process confinement labels and policy denials; the ChatGPT Electron profile is not a prerequisite for LCU's direct Node/REPL path. The [ARM64 and x86-64 Ubuntu AppArmor host runs](verification/installed-app-2026-09-23.md) passed native use and no-sign-in Chrome actions with actual process labels. The x86-64 guest used KVM on physical AMD hardware. Docker fixtures alone prove bounded native behavior and offline failure paths, not host OS confinement.

`tests/node/sandbox_shim.test.mjs` covers the Linux sandbox launcher's recognition rules. On a Linux host where bubblewrap works, `LCU_TEST_SANDBOX_SHIM_FAULT=unrecognized-kernel`, `unrecognized-worker` or `unrecognized-format` makes the launcher see that invocation in a format it does not recognise; it can only make the launcher refuse (exit 70), never run something unsandboxed, and is for checking that a refusal leaves nothing running. LCU never sets it. The [kernel sandbox record](verification/linux-kernel-sandbox-2026-10-05.md) shows its use.

`tests/node/approval.test.mjs` covers the approval-mode entries for every harness. `tests/codex_approval_mode.py --cli PATH` drives a Codex CLI with a scripted local provider and compares `ask` and `auto` registration; it needs Node and `npm ci --prefix adapters`, and is not part of `tests/run.sh`.

Chrome verification uses the original MCP → browser service → LCU relay → original native host → extension chain and an isolated Chrome profile. The target path must complete navigation, input, click, screenshot and lifecycle without Codex sign-in, and the fixture server must observe `x-browser-agent` on the requests. The original browser also requests scoped MCP site approval; a test client may approve its own disposable localhost fixture, but must not synthesize a broader grant. Never copy a personal credential store. The [current status](PARITY-STATUS.md) distinguishes this local policy override from the original Codex account policy.

Historical IAB fixture and full-copy bundle evidence predates this migration. [Verification](VERIFICATION.md) and [current status](PARITY-STATUS.md) separate those results from final thin-artifact claims.
