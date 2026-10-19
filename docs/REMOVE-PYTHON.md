# Remove Python from LCU

Status: port complete, verification in progress (see [Status](#status)); delivered as one PR. This brief replaces the first attempt (PR #25, branch `node-runtime`), which was
closed unmerged. Every agent working on this port works from this page; if something here is wrong or unclear, raise
it before working around it.

## Goal

**Remove Python from LCU.** LCU runs entirely on the Node that ships inside the ChatGPT app (`cua_node`), on Linux,
macOS and Windows: install, setup, launch, browser relay and update. Users need nothing installed beyond the official
app.

Codex computer use itself is already JavaScript running on that Node. Only LCU's own glue is Python today, so the port
removes a dependency; it does not change what computer use does.

### What must not change

These are what users and agents depend on:

- The files `lcu setup` writes for each agent (Codex, Claude, Pi, OMP, Hermes, ...), compared as parsed data, not
  bytes.
- Exit codes, and the commands and flags LCU accepts.
- How computer use is launched: which original app files run, with which arguments and environment. LCU hands over to
  the original runtime and adds nothing to it (AGENTS.md).
- Safety checks: app identity and signature, file permissions, caller sandbox and approval settings.
- The install layout, and upgrading in place from an installed Python release (0.9.7).

### What may change

- The wording of errors and help text (keep it clear and actionable).
- The internal file layout of the LCU tree.
- Anything a user cannot observe.

### How it is built

- Idiomatic Node using its own libraries: `node:util` `parseArgs` (or a small hand-written parser), `node:zlib`, JSON,
  `node:path`, `node:child_process`. **Do not imitate Python's libraries, error formats or quirks.** No CPython-style
  argparse, tracebacks, `[Errno N]` formatting, Python JSON spacing, chunked-read emulation, and so on.
- **Size check.** The Python runtime is about 9k lines (`lcu/*.py` plus the shipped `scripts/*.py`). The Node runtime
  should be about the same size. If `lcu/` grows past about 1.5x, stop and explain why in the PR.
- **Speed budget.** Every entry point (`lcu`, `lcu-session`, `lcu-codex-sandbox`) must start at least as fast as the
  Python version on the same machine. CI measures the median startup time and fails above the budget. Pre-launch
  checks must not fork a process per path component or verify a code signature twice.
- The AGENTS.md rules still apply in full: use the original app's runtime, add no input, screenshot, accessibility,
  browser or MCP implementation of LCU's own, and keep app binaries out of Git.

### How it is tested, in proportion

1. **Port the existing unit tests.** `tests/test_*.py` (43 files, about 12k lines) already describe the intended
   behaviour. Port each one to `node:test` alongside the module it covers, and keep the assertions that matter (files
   written, exit codes, commands run). Drop assertions that only pin Python wording.
2. **One end-to-end check per command against 0.9.7.** Run the old and new releases in the disposable Linux image.
   Compare the written agent config files as parsed data, plus exit codes and the launch command and environment. Do
   not compare stdout or stderr byte for byte.
3. **One upgrade test.** Install 0.9.7, run its `lcu update` against the new archive, then check `lcu status`,
   `lcu doctor`, an MCP launch, the agent registrations, and rollback. Run it on Linux in CI, and on the macOS guest
   before release.
4. **The existing real-desktop gates.** `tests/run.sh` (Linux, CI), the macOS guest
   (`docs/verification/macos-test-guest-access.md`) and a Windows run, each before claiming that platform.

A test that needs code written only to make the test pass is a red flag. Report it instead of writing that code.

## What uses Python today (on `main`)

| Area | Files | Notes |
|---|---|---|
| Launchers | `bin/lcu`, `bin/lcu-session`, `bin/lcu-codex-sandbox` | `#!/usr/bin/env python3` |
| Launch path | `lcu/runtime.py`, `platforms.py`, `app_layout.py`, `interpreter.py`, `session.py`, `sandbox_shim.py`, `native_host.py`, `capture.py`, `diagnostic_log.py`, `macos_host.py` | Hands over to the original runtime |
| Setup and management | `lcu/setup.py`, `setup_clients.py`, `harness_setup.py`, `approval.py`, `codex_hooks.py`, `app_server.py`, `claude_mod.py`, `claude_visibility.py`, `apps.py`, `asar.py`, `origins.py`, `browser.py`, `doctor.py`, `status.py`, `maintenance.py`, `tested.py` | |
| Install and update | `scripts/install.py`, `install_macos.py`, `install_windows.py`, `windows_launcher.py`, `installed_app.py`, `bundle.py`; `lcu/update.py`, `update_apply.py`, `windows.py`, `windows_host.py` | Windows install is Python today |
| Linux input guard | `XRES_HELPER_SCRIPT` in `lcu/linux_sky_service.mjs` | Runs `python3 -c` with ctypes into libX11, XRes and XTest. See the open question below |

**Out of scope:**

- **`adapters/hermes/__init__.py`.** It is Hermes's own plugin and runs inside Hermes, which is a Python agent.
- **Build and CI tooling** (`scripts/build_bundle.py`, `check_archive.py`, `provision_agent_tools.py`, test drivers)
  may stay Python for now. It is never shipped to users. Porting it later is optional.

**Compatibility stubs.** Thin compatibility stubs are allowed temporarily, only where an *already installed* Python
release calls into the new archive during its own `lcu update` (for example a `scripts/install.py` that only hands
over to the Node installer). They must contain no logic. The old release's own Python is what runs them.

## Open question: the Linux input guard

LCU's Linux service wrapper checks, before and after input, which window is under the pointer and whether another
client holds a pointer grab. It also releases keys and buttons when a call times out. It does this through a Python
ctypes script, because Node cannot call libX11 without a native add-on.

Before porting it:

1. Check whether the original app's Linux computer-use runtime already covers this, in which case LCU should drop it
   (AGENTS.md: input belongs to the original runtime).
2. If LCU must keep it, speak the X11 protocol directly from Node over the display socket (XRes `QueryClientIds`,
   `QueryPointer`, `QueryKeymap`, `GrabPointer`, `TranslateCoordinates`, XTEST `FakeInput`). That is a few hundred
   lines with no dependency. Port its behaviour as it is, without redesigning it.

Either way, no Python remains on Linux.

## Order of work

The port is delivered as **one PR**. It merges once everything below is done and CI is green. Work proceeds in this
order inside it:

1. **Foundation and launch path:** the launcher contract below, the three launchers and the modules they need. The
   speed budget applies here first.
2. **Setup and management commands. Install and update** on all three platforms, plus the upgrade test from 0.9.7.
   **The Linux input guard**, per the open question.
3. **End-to-end checks, the speed budget in CI, and a check that no `python3` is reachable** while installing and
   running.
4. **Cleanup:** delete the Python runtime, update `docs/INSTALLATION.md`, `docs/ADAPTERS.md` and
   `docs/DEVELOPMENT.md` requirements, and record what was verified on which platform.

## Conventions for the Node code

- ES modules (`.mjs`) under `lcu/`, one per Python module, with the same name (`lcu/setup.py` becomes
  `lcu/setup.mjs`). Merge or drop modules only where the Python split no longer makes sense. Node 22.15 or later
  (`process.execve`). No npm dependencies in the runtime.
- **Errors:** throw an `Error` with a clear message. The entry point prints `LCU: <message>` and exits 1, like the
  Python launchers. No custom exception hierarchies beyond what callers need to tell cases apart.
- **Tests:** `tests/node/<module>.test.mjs` with `node:test` and `node:assert/strict`, run by `node --test tests/node/`.
  A ported module's Python test file is deleted in the same change.
- **Reading the Python originals:** once a `.py` file is deleted, read it with `git show origin/main:<path>`.

### Launcher contract (Linux and macOS)

- `bin/lcu`, `bin/lcu-session` and `bin/lcu-codex-sandbox` are short `/bin/sh` scripts. They run
  `lcu/runtime.mjs`, `lcu/session.mjs` and `lcu/sandbox_shim.mjs` respectively, with all arguments, through
  `exec`, and spawn nothing else (only a launcher invoked through a symlink to the script file itself runs
  `readlink` to find its release).
- **Recorded Node.** The installer writes `<release root>/node-path`: one line, the absolute path of the app's
  Node (`…/Resources/cua_node/bin/node` on macOS, `…/resources/cua_node/bin/node` on Linux, the managed private
  copy's `…\cua_node\bin\node.exe` on Windows), with or without a trailing newline. The launcher reads it with
  the shell's `read` builtin and requires an executable regular file.
- **No `node-path`** (a source checkout, tests): the launcher uses `LCU_NODE` from the environment. A release
  with `node-path` ignores `LCU_NODE`, also when the file is empty or unreadable.
- **Neither usable:** the launcher prints `LCU: …` (`LCU session: …` for `lcu-session`) naming the problem —
  the recorded Node is missing or not executable (repair the app, reinstall LCU), or no Node is recorded and
  `LCU_NODE` is unset — and exits 1. Plain `lcu --help` and `lcu -h` (no other argument) still print the usage,
  which lives in `lcu/usage.txt`: the single source both the launcher and `runtime.mjs` print.
- Inside Node, an entry module runs only when it is the script Node was started on (`lcu/entry.mjs`); a thrown
  `Error` prints `LCU: <message>` and exits 1, and a returned number is the exit status.
- The launch path takes builtins from `process.getBuiltinModule` and loads `child_process`, `crypto` and `tty`
  only where they are used: an ESM `import` of a builtin costs milliseconds on every launch.
- Identity checks on the app (signature, ownership) run inside Node, as the Python runtime ran them, and each runs
  once per launch.
- Where `lcu` waits for the original server (macOS, Windows), it exits with the server's status, or with
  128 + N when signal N ended it (the shell convention; Python LCU happened to give 256 − N).
- On Windows, `bin\lcu.cmd` reads the same `node-path` (or `LCU_NODE`) and runs `lcu\runtime.mjs`. The
  account-local `<prefix>\lcu.cmd` the installer writes runs the recorded Node on
  `<prefix>\windows_launcher.mjs` (copied from `scripts/windows_launcher.mjs`), which selects the release from
  `current.json` and runs its `lcu/runtime.mjs` in the same process.
- Tests: Node 22 does not take a directory for `node --test`; name the files, as in
  `node --test tests/node/*.test.mjs`.

### Windows bootstrap

- `scripts/install.ps1` finds the registered official Store app, checks its identity and signature, and runs the
  app's `node.exe` on the Node installer. If that `node.exe` cannot be executed in place, it uses a temporary copy of
  `cua_node` instead.
- Everything else, including the private app copy, is Node.

## Using the first attempt as reference

The `node-runtime` branch (PR #25) is kept for reference, not for merging. Reviewers confirmed that its computer-use
handover is faithful to the original runtime. Its platform knowledge is worth reading:

- handing the process over with `process.execve`
- verifying `cua_node` before running it
- macOS code-signature checks
- Windows file locks
- running under an app-owned Node

Do not copy its `lcu/compat/` layer, its byte-for-byte black-box harness, or its deviations list. They exist to
imitate Python and are what this brief rules out.

## Status

What is verified where, for the port as merged on this branch (LCU 0.10.0):

| Platform | Verified | Not yet verified |
|---|---|---|
| Linux x64 | CI on `ubuntu-24.04`, green on this branch: Node tests (Node 22.15.0 and 24), the build-tooling and adapter tests, `tests/e2e` against the 0.9.7 archive, `tests/run.sh linux/amd64`, the archive payload check and lint. Locally: `node --test tests/node/*.test.mjs` (Node 22.22); the build-tooling and adapter tests; `tests/e2e` against the 0.9.7 archive: `setup`, `exit`, `launch`, `upgrade` (runtime-only and agent mode, with rollback), `nopython` and `startup` all pass, the only accepted difference being the relay rename `lcu-native-host.py` → `lcu-native-host.mjs`; startup medians 64 ms against 114 ms (`lcu --version`) and 32 ms against 64 ms (`lcu-session --help`, `lcu-codex-sandbox --help`); the real-desktop gate (`tests/run.sh linux/amd64` steps: offline and read-only installs, the no-Python install and run, registrations, GTK/X11/Qt/GTK 4 input through every adapter path, the required original sandbox) on a native amd64 Docker host. That local gate ran `tests/run.sh`'s steps unchanged except that the image added the host's TLS proxy CA and the archive was the one `tests/e2e` built on the host from the same tree. | |
| Linux arm64 | CI on `ubuntu-24.04-arm`, green on this branch: Node tests (Node 22.15.0 and 24), `tests/e2e` against the 0.9.7 archive, and the real-desktop gate `tests/run.sh linux/arm64`. | Any local run outside CI. |
| macOS arm64 | CI on `macos-latest`, green on this branch: Node tests (Node 22.15.0 and 24) and the build-tooling and adapter tests. On the user's Mac (not the guest), with a scratch home: install, `status`/`doctor` and startup against 0.9.7, setup, MCP launch and shutdown through the Codex and Claude Code registrations, a live TextEdit action through real Codex CLI and Claude Code sessions (screenshot, menus, Unicode text, save, exact bytes), concurrent sessions, 0.9.7's own `lcu setup` and `lcu update` to this release with rollback, and the setup lock against a real 0.9.7 `lcu setup` in both directions, with no Python reached ([record](verification/macos-node-port-2026-10-08.md)). | On the task-owned macOS guest (`docs/verification/macos-test-guest-access.md`): the whole set, including the browser relay, which was not run on the user's Mac either. |
| Windows x64 | CI on `windows-latest`, green on this branch: Node tests (Node 22.15.0 and 24), the build-tooling and adapter tests, and the Windows archive build; tests that need POSIX skip themselves with a reason (their loading was checked with a simulated `win32`, not on Windows). | Any live Windows run: `install.ps1` with the Store app, a computer-use action, the upgrade from 0.9.7, and the lock files against a running 0.9.7 host. Structural checks and CI are not live evidence. |
