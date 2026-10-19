# Linux kernel sandbox with a working Sky service

Date: 2026-10-05. Change: on Linux the model's JavaScript kernel stays inside `codex sandbox` and only the trusted Sky worker runs outside it (see [adapters](../ADAPTERS.md#linux-sandbox-state)). LCU 0.8.2 to 0.9.2 sent a `disabled` sandbox state instead, which left the kernel unsandboxed.

Setup: an x86-64 Ubuntu 24.04 host with KVM and working bubblewrap, the new LCU archive built there (`python3 scripts/build_bundle.py`) with its `lcu/` and `bin/` extracted over two overlay prefixes that use the installed official apps in place (ChatGPT 26.930.41038, runtime 0.0.27, and ChatGPT 26.915.31945, runtime 0.0.16; each with its own Codex CLI, 0.160.0 and 0.155.0-alpha.9.2). A private Xvfb display with xfwm4, a private session D-Bus, and a throwaway `HOME`, `CODEX_HOME` and approvals file per session; the host's real desktop session and home were not used. All results are live against the original `node_repl` and Sky. Neither Chrome nor any account-backed model was involved.

## Kernel confinement (every row on both runtimes)

The `js` call ran in the kernel and tried each action; the oracle is the error code and the filesystem afterwards.

| Check | Result |
| --- | --- |
| Write a file in HOME, in the working directory, in `/tmp`, and overwrite the approvals file | Refused with `EROFS`; no file created, approvals unchanged |
| Synchronous spawn (`execFileSync('/bin/sh')`) | Refused with `EPERM` |
| Outbound TCP to a local listener | Refused with `EPERM`; the listener saw no connection |
| X11 (file socket and abstract socket) and the session D-Bus socket | Refused with `EPERM` |
| `/proc/self/status` | `Seccomp: 2` |
| Asynchronous `child_process.spawn` | Allowed by `node_repl`; the child cannot write HOME or the working directory, cannot connect, and runs with `Seccomp: 2` |

## Computer use in the same session

| Check | Result |
| --- | --- |
| `cua.listWindows`, `app.getScreenshot()` (an image content item reached the client), `sky.get_screenshot` | Passed |
| Activate an xterm and type `lcu-ok-7` with `sky.press_key` | The file oracle held exactly `lcu-ok-7` |
| Process table | Trusted worker `Seccomp: 0` (outside the sandbox), kernel `Seccomp: 2` |
| `tests/gtk4_input.py` (GTK 4 desktop-level text, keys, Return, coordinate click, window-targeted translation, overlay, modal, concurrency, `off`) | Passed on both runtimes |
| `tests/linux_input_hang.py`, `tests/linux_input_drag.py` (worker restarts under the shim) | Passed on both runtimes |
| `tests/adapter_paths.py` (bare client, Codex relay, Claude relay, Pi/OMP shared client, Hermes bridge, `LCU_REQUIRE_SANDBOX=1`) | Passed on both runtimes: `host` reproduces the original X11 failure, the default gives a confined kernel and working computer use, a restricted host profile still works, `off` runs the kernel unsandboxed |
| `lcu doctor` | Prints `JavaScript sandbox: active` and the usual readiness lines |

## Modes and host-supplied state

| Check | Result |
| --- | --- |
| Host sends `disabled` | Kernel unsandboxed (`Seccomp: 0`, writes and spawn allowed), computer use works |
| Host sends a managed read-only profile | Kernel boxed, computer use works |
| `LCU_NODE_REPL_SANDBOX=host` | Original behavior: kernel boxed, `Could not connect to X11 ... Operation not permitted` |
| `LCU_NODE_REPL_SANDBOX=off` | Kernel unsandboxed, computer use works |
| `tests/codex_sandbox_state.py --cli <app codex>` (Codex CLI 0.160.0) | Direct: managed/restricted for `read-only` and `workspace-write`, `disabled` for `danger-full-access`; relay: nothing. Unchanged from the 2026-10-02 record |

## Failing closed

The fault hook `LCU_TEST_SANDBOX_SHIM_FAULT` (see [development](../DEVELOPMENT.md)) made the launcher see an invocation in a format it does not recognise.

| Check | Result |
| --- | --- |
| `unrecognized-kernel` | The `js` call failed and showed `node_repl`'s kernel diagnostics with the launcher's message (exit 70); no kernel process was started |
| `unrecognized-worker` and `unrecognized-format` | The `js` call failed with `trusted Node process exited unexpectedly; kernel reset, rerun your request`; the launcher's message is only on the MCP server's stderr; no kernel or worker process was started |
| Lookalike Sky (a copy of the Sky package in a same-named folder, named as the Sky service) | The worker was handed to the sandbox (`Seccomp: 2`) and failed with the X11 error; the launcher noted that the service is not the selected runtime's |
| Lookalike worker invoked directly (right file names and folder shape, parent not `node_repl`) | Ran with `Seccomp: 2` |
| Lookalike Node (a copy of `node` in another folder), an arbitrary command, a kernel with an extra argument, no configuration | Refused (exit 70); nothing ran |
| Other `codex` subcommands | Passed through (`--version`) |

The model sees the launcher's explanation only for a refused kernel. For a refused worker the original `node_repl` forwards no stderr, so the explanation is in the harness's MCP server logs; this is documented rather than worked around, because a model-visible message would need LCU to proxy the original server.

## Where bubblewrap does not work, and the sealed gate

Unit tests (`tests/test_sandbox_shim.py`, `tests/test_runtime.py`, `tests/test_doctor.py`) cover the recognition rules, environment wiring, modes and doctor text. `tests/run.sh linux/amd64` ran the sealed gate: the container without bubblewrap behaves as before (`node_repl` runs both processes directly, `lcu doctor` reports the sandbox as not available), and the sandbox-enabled container requires and exercises the checks above.

The gate passed with no failure. In the container without bubblewrap `lcu doctor` printed `JavaScript sandbox: NOT AVAILABLE here (bubblewrap cannot start a sandbox; ... bwrap: No permissions to create new namespace ...)` and every desktop test, including the GTK flow through the five adapter paths and the input tests, passed as before. In the two sandbox-enabled containers (the same app mounted read-only in two version folders) doctor printed `JavaScript sandbox: active` and `tests/adapter_paths.py` passed its sandbox controls with `LCU_REQUIRE_SANDBOX=1`, along with `tests/integration.py`, `tests/gtk4_input.py`, `tests/linux_input_controls.py`, `tests/linux_input_hang.py`, `tests/linux_input_drag.py` and `tests/linux_xres_namespace.py`. The container gate uses the pinned ChatGPT 26.915.31945 package.

## Found while verifying

The doctor's availability check first ran from the launch directory and reported "Permission denied" when the account could not enter it; it now runs from its own scratch directory. Also, with no sandbox state of its own, `node_repl` starts the kernel in the process's working directory. An exported plugin run from a directory the account cannot enter then failed with "Permission denied". `lcu` now starts the original runtime from `/` in that case.

## Not tested

Claude Code, Pi, Oh My Pi, Hermes and a system Codex CLI are not installed on the verification host; their registrations were exercised only through the shared relay and client paths of `tests/adapter_paths.py`. Chrome was skipped. `tests/linux_input_controls.py` needs PyQt5, which the host does not have outside the container; it passed inside the sealed gate only (on 26.915.31945). ARM64 was not run. Results apply to the two runtime versions above.
