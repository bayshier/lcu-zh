# macOS Node port check on the user's Mac, 2026-10-08

Live check of PR #31 (LCU 0.10.0, Python removed) against LCU 0.9.7. At the user's request it ran on the user's
own Mac, not the task-owned guest, with every LCU write confined to scratch directories under `/private/tmp`.
**Result: install, `--version`/`status`/`doctor`, setup isolation, MCP launch through both registrations,
shutdown, the 0.9.7 → 0.10.0 upgrade with rollback, and the setup lock passed. The TextEdit action (screenshot,
Unicode typing, save, `xxd`) was not run: in a scratch HOME no app is approved, and approving one needs the
user (see [Not verified](#not-verified)).** No Python ran in any step that used the new build. A later
[exhaustive run](#exhaustive-run-2026-10-08-evening) the same evening ran the TextEdit action through real Codex and
Claude Code sessions. It also covered 0.9.7's own setup, update and lock against the real home, inside a window the
user approved and restored exactly, and it fixed the Claude relay's linger after its host exits.

## Isolation incident and the HOME fix

An earlier attempt the same day ran `env -i HOME=<scratch> <prefix>/bin/lcu setup --agent codex|claude-code --yes`
and expected isolation. Setup took the account's home from the user database (`os.userInfo().homedir`), not
`HOME`, so it rewrote the real `~/.codex/config.toml`, `~/.claude.json`, `~/.claude/skills/lcu-approve` and
`~/.local/state/lcu/setup.json`. The user restored them (LCU 0.9.5). The default prefix, `lcu status`,
`lcu update` and the agents themselves already followed `HOME`, so LCU disagreed with itself.

Commit `5507f1f` (`fix(setup): target $HOME for non-root runs`): without `--user`, setup, the installer's setup
step, `lcu status` and `lcu update` (including its refresh of the Claude Code mod) use `$HOME` when it is an
absolute, existing directory owned by the caller with no symbolic link on its path. Otherwise they use the
user database home. Root and `--user` are unchanged (root must still pass `--user`). The installer now forwards
`--user` only when it was given; before, it always forwarded the caller's name, which would also have selected
the user database home. A failed setup's retry command names `--user` only when the caller did. Unit tests:
`tests/node/fsutil.test.mjs` (HOME honoured; unset, empty, relative, missing, linked, linked parent, `..`,
control character and another owner's HOME fall back; root ignores HOME) and two tests in
`tests/node/setup.test.mjs`.

Commit `0e47a2e` (`fix(setup): warn when a macos home is not the account home`) follows from step 3 below.

## Host and app

| Item | Value |
| --- | --- |
| Machine | User's Mac, macOS 26.5 (25F71), arm64 |
| ChatGPT.app | 26.930.61225 (build 13232), signed `com.openai.codex`, team 2DC432GLL2 |
| CUA runtime | 0.0.27/20260927214556-b77d38801cca |
| Node (recorded `node-path`) | `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`, v24.21.0 |
| Tested pair | No. `tested-versions.json` lists 26.917.62051 (CUA 0.0.16) and 26.928.20755 with this runtime; informational only |
| New archive | `lcu-0.10.0-darwin-arm64.tar.gz` built by `scripts/build_bundle.py --platform darwin --app /Applications/ChatGPT.app` at `5507f1f`, SHA-256 `a3a6f2e7…5695a6`; rebuilt at `0e47a2e` (`49ab05d2…e0a1fb`) for the warning check. `check_archive.py`: ok |
| Old archive | `lcu-0.9.7-darwin-arm64.tar.gz`, SHA-256 `5078fb7e…312b6f4a`, matching `docs/releases/0.9.7.md` |
| Clients present | Codex CLI 0.160.0, Claude Code 2.1.204 |

## Safety guard

Before any install, setup, update or lock run, a script recorded SHA-256 and mtime of the real
`~/.codex/config.toml`, `~/.codex/hooks.json` and `hooks/`, `~/.claude/settings.json`,
`~/.claude/skills/lcu-approve/**`, `~/.local/state/lcu/**`, `~/.local/share/lcu` (three levels),
`~/.omp/agent/config.yml` and its MCP and extension entries, `~/.local/bin/lcu*`, the approved-app list
(`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/…/ComputerUseAppApprovals.json`) and a hash
of the MCP server entries in `~/.claude.json` (the whole file changes with every Claude Code session). It was
re-checked after every step and after cleanup: **no change at any point**.

Every new-build step ran with `env -i`, a scratch `HOME` and `PATH=<stubs>:/usr/bin:/bin:/usr/sbin:/sbin`, where
`<stubs>` held `python` and `python3` scripts that log argv, ppid, cwd and time and exit 127. **Their log stayed
empty for every new-build step.** It got one line once, when the new build's setup was pointed at a 0.9.7
prefix and ran 0.9.7's own Python launcher (`prefixU/current/bin/lcu --version`); that run was repeated with
Python on `PATH` and is not a new-build call.

## Steps

| Step | Result | Evidence |
| --- | --- | --- |
| 1. Build and install | Pass | `install.sh --prefix <A> --runtime-only --yes`: `lcu 0.10.0 (ChatGPT darwin 26.930.61225; CUA 0.0.27/…)`; stub log empty |
| 2. `--version`, `status`, `doctor`; startup | Pass | All exit 0; diagnostic log under the scratch HOME; table below |
| 3. Setup isolation | Pass | Configs only in the scratch homes; guard unchanged |
| 3. MCP launch through each registration | Pass (minimal client) | `cua.getState()` lists running apps through both the Codex and the Claude Code registration |
| 3. TextEdit: screenshot, Unicode, save, `xxd` | **Not run** | `Computer Use was not approved to use TextEdit` |
| 4. SIGINT, SIGTERM, SIGKILL | Pass for Codex; Claude Code drains in about 22 s, as 0.9.7 does | ps output below |
| 5. 0.9.7 `lcu update` → new, rollback | Pass, with the registration caveat below | |
| 6. Setup lock | Pass, with 0.9.7's lock code instead of a full 0.9.7 `lcu setup` | |

### Startup (step 2)

`/private/tmp/…/tools/timing.mjs`: one warm-up, then 21 runs per side, alternating order, `env -i` with a scratch
HOME; the new build with the Python stubs, 0.9.7 with Python 3.12 on `PATH`.

| Command | 0.10.0 median | 0.9.7 median | 0.10.0 min | 0.9.7 min |
| --- | --- | --- | --- | --- |
| `lcu --version` | 692 ms | 710 ms | 675 ms | 690 ms |
| `lcu status` | 710 ms | 750 ms | 701 ms | 739 ms |
| `lcu doctor` | 758 ms | 795 ms | 741 ms | 767 ms |

The previous run measured 688/703, 705/743 and 748/784 ms. Both versions spend most of this time in the app's
signature checks.

### Setup into a scratch HOME (step 3)

~~~sh
env -i HOME=<W>/homeCodex  PATH=<stubs>:… <A>/current/bin/lcu setup --prefix <A> --agent codex       --yes --no-chrome
env -i HOME=<W>/homeClaude PATH=<stubs>:… <A>/current/bin/lcu setup --prefix <A> --agent claude-code --yes --no-chrome
~~~

Both exited 0. Files written: `homeCodex/.codex/config.toml` (`[mcp_servers.lcu]` running
`<A>/current/agent-tools/node/bin/node <A>/current/adapters/codex.mjs <A>/current/bin/lcu`, the
Stop/Interrupt/SubagentStop `turn_ended` hooks with their trust state, the update-notice hooks) and
`homeCodex/.local/state/lcu/{setup.json,setup.lock}`; `homeClaude/.claude.json` (`mcpServers.lcu`, same shape with
`adapters/claude.mjs`), `homeClaude/.claude/settings.json` (deny list and the `set_turn_context`/`turn_ended`
hooks), `homeClaude/.claude/skills/lcu-approve/**`, and `homeClaude/.local/state/lcu/*`. Guard: unchanged.
`install.sh --prefix <A2> --agent codex` from the rebuilt archive also wrote only into its scratch HOME.

**Client authentication.** `codex login status` and `claude auth status` in the scratch homes report not
logged in, and no credentials were copied. So both actions used a **minimal MCP client, not Codex or Claude
Code**: a Node script using the official MCP SDK (1.30.0, the copy vendored in `adapters/node_modules`) that reads
the registered command from the scratch `config.toml` or `.claude.json` and starts it with the scratch HOME. For
Claude Code it also sends what the registered hooks send: `set_turn_context` before each `js` call (with the
`claudecode/toolUseId` `_meta`) and `turn_ended` Stop at the end.

**The helper socket follows HOME.** With only the scratch HOME, `cua.getState()` returned
`{"apps":[],"browsers":[],"errors":["Native apps: Error: Sky Computer Use native pipe startup failed"]}`
through both registrations. The original client builds the helper's socket path from `HOME`
(`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock`), and the running helper
listens under the real home. The attempt also started a second `SkyComputerUseService` (pid 46969, from the app
bundle, parent launchd); it exited on its own within 9 minutes and was not signalled. With
`SKY_CUA_SERVICE_NATIVE_PIPE_PATH` set to the real socket in the server environment, `cua.getState()` listed the
running apps through both registrations. Because setup now honours `HOME`, setup on macOS warns when the home it
configured is not the account's home folder (commit `0e47a2e`, rebuilt archive):

~~~
Warning: setup configured the agents in /private/tmp/lcunp.CZBu/homeW, not in this account's home folder
/Users/polarzero. The original Computer Use client finds the ChatGPT helper from HOME, so an agent started with
this HOME cannot reach it ('native pipe startup failed') unless SKY_CUA_SERVICE_NATIVE_PIPE_PATH names the
helper's socket.
~~~

**TextEdit.** `let app = await cua.getApp("TextEdit");` returned `Computer Use was not approved to use TextEdit`
through both registrations. The original client reads its approved-app list from `HOME` too, and the scratch
homes have none. The minimal client advertises no elicitation, so no approval panel appeared; none was answered
and no approval file was edited. Without an approved app there is no app to screenshot either. The sub-step
stopped here.

### Shutdown (step 4)

Each run: `cua.getState()`, then a `js` call that waits 60 s; 6 s in, the client got the signal; `ps` 5 s later.

| Client | SIGINT | SIGTERM | SIGKILL |
| --- | --- | --- | --- |
| Codex registration | 0 left | 0 left | 0 left |
| Claude Code registration | relay and tree left at 5 s | same | same |

Before the signal, each run had 7 processes: the client; `adapters/{codex,claude}.mjs`; `lcu/runtime.mjs` on the
app's Node; two `codex sandbox` processes; the original `kernel.js` and `trusted-worker.js`. For Claude Code,
`adapters/claude.mjs` was re-parented to launchd and its tree stayed until the in-flight call's turn cleanup
ended. Polling every 0.5 s, the last process exited **22.0 s** after SIGKILL and 22.0 s after SIGTERM with the new
build, and **22.0 s** and 21.5 s with 0.9.7. The relay is the same file in both releases. On stdin EOF it
sends Interrupt cleanup for active turns before closing upstream, bounded by the 20 s cleanup step
(`CLEANUP_STEP_HARD_TIMEOUT_MS`). With no call in flight, SIGKILL and SIGTERM left nothing behind for either
registration (0 processes at the first poll). This is not a port regression; whether the relay should cut the
drain shorter is a separate question. (It now does: see [D. Lifecycle](#d-lifecycle) in the exhaustive run.) Example `ps` 5 s after SIGKILL of the Claude Code client:

~~~
51444     1 …/prefixA/current/agent-tools/node/bin/node …/adapters/claude.mjs …/bin/lcu
51445 51444 /Applications/ChatGPT.app/…/cua_node/bin/node …/prefixA/current/bin/../lcu/runtime.mjs
51466 51451 …/CodexCLI.app/Contents/MacOS/codex sandbox …
51467 51451 …/CodexCLI.app/Contents/MacOS/codex sandbox …
51482 51467 …/cua_node/bin/node --experimental-vm-modules /private/tmp/.tmpt5EpBM/trusted-worker.js …
51483 51466 …/cua_node/bin/node --experimental-vm-modules /private/tmp/.tmpt5EpBM/kernel.js …
~~~

Two artefacts of the minimal client: closing it right after `turn_ended` stops the server while the original
`turn-ended` command runs (`exit=SIGKILL elapsed=5 ms`); waiting 1.5–3 s before closing avoids it. Reusing a
turn id after its `turn_ended` gives `Computer Use is unavailable because the current turn ended`. Real clients
keep the server between turns and use new turn ids.

### Upgrade and rollback (step 5)

1. 0.9.7 `install.sh --prefix <U> --runtime-only` with HOME `<W>/homeU`.
2. Registrations for Codex and Claude Code in `homeU` pointing at `<U>/current`. **These were written by the new
   build's setup (`<A>/current/bin/lcu setup --prefix <U>`), not by 0.9.7's:** 0.9.7's setup takes the home from
   the user database and cannot be pointed at a scratch home on this account. Both launched 0.9.7 and listed apps.
3. 0.9.7's own `lcu update` through `UPDATE_DRIVER` from `tests/e2e/e2e.py` (its downloads redirected to the local
   archive and its `.sha256`), `python3 -I` with the stubs on `PATH`: exit 0, `LCU update: 0.9.7 -> 0.10.0`, the
   new installer's output, `Refreshed the Claude Code lcu-approve mod at <W>/homeU/.claude/skills/lcu-approve`.
   `current` → `releases/0.10.0-ead33c7c36a3`; the 0.9.7 release stayed. Stub log empty.
4. After the update, with the stubs: `--version` (`lcu 0.10.0`), `status`, `doctor` exit 0, and both
   registrations started the Node runtime and listed apps.
5. Rollback by reinstalling 0.9.7 runtime-only: `current` → `releases/0.9.7-472a9dc7f2d5`; `lcu --version`
   `0.9.7`, `status`, and both registrations listed apps again.

Guard: unchanged after each step. Without the HOME fix, step 3 would have refreshed the real home's mod.

### Setup lock (step 6)

All in `<W>/homeL`. A full 0.9.7 `lcu setup` cannot be isolated (it uses the user database home), so the 0.9.7
side used 0.9.7's own `lcu.setup.setup_lock` (`fcntl.flock`) imported from its installed release.

| Holder | Waiter | While held | After `kill -9` of the holder |
| --- | --- | --- | --- |
| 0.9.7 `setup_lock` | new `lcu setup --agent codex` | still running at 8 s, printed `LCU: waiting for another LCU process to release …/setup.lock...`, no config written; `lsof`: only the Python holder | setup finished, exit 0, 9 s in total; config written |
| new `setupLock` (`O_EXLOCK`) | 0.9.7 `setup_lock` | blocked at 5 s; `lsof`: both descriptors | acquired after 5.1 s |
| new `setupLock` | new `lcu setup --agent claude-code` | blocked at 6 s, same waiting message | exit 0, 7 s in total; config written |

## Exhaustive run, 2026-10-08 evening

The user asked for an exhaustive live run on the same Mac. It used the archive built with the relay fix below (commit `a5bc374`, built from it before it was rebased onto `2e6f094`),
installed into a scratch prefix, and one scratch home. In that scratch home the user approved TextEdit
themselves (`lcu apps allow TextEdit`, Touch ID; it applies to that home only) and logged in Codex CLI and
Claude Code themselves. No credentials were copied, and no approval was answered or edited by the run. Clients ran
with `env -i`, the scratch `HOME`, and `SKY_CUA_SERVICE_NATIVE_PIPE_PATH` set to the helper socket under the real
home. The Python stubs (above) were first on `PATH` for every new-build step, and **their log stayed empty for the
whole run**.

| Item | Value |
| --- | --- |
| ChatGPT.app | 26.930.61225 (build 13232) |
| CUA runtime | 0.0.27/20260927214556-b77d38801cca |
| Node | `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`, v24.21.0 |
| Tested pair (`tested-versions.json`) | No (warning only) |
| Clients | Codex CLI 0.160.0, Claude Code 2.1.204 |
| New archive | `lcu-0.10.0-darwin-arm64.tar.gz` with the relay fix (before the rebase), SHA-256 `2454b63b…e8ef3ba4e`, `check_archive.py`: ok |
| Old archive | `lcu-0.9.7-darwin-arm64.tar.gz`, SHA-256 `5078fb7e…312b6f4a` (matches `docs/releases/0.9.7.md`) |

### A. Install and no Python

`install.sh --prefix <scratch> --runtime-only --yes`, then `--version`, `status` and `doctor` all exit 0. The
installed prefix has no Python shebang. Its only `.py` files are the `scripts/install_macos.py` hand-off stub for
0.9.7's `lcu update` and the Hermes plugin (`adapters/hermes/__init__.py`, which runs inside Hermes).

### B. Startup

One warm-up run, then 21 runs per side in alternating order. 0.9.7 ran with Python 3.12 on `PATH`. "MCP" is the
time from starting the registered command to a completed `tools/list`, measured by a client on the official MCP SDK.

| Command | 0.10.0 median | 0.9.7 median | 0.10.0 min | 0.9.7 min |
| --- | --- | --- | --- | --- |
| `lcu --version` | 670 ms | 686 ms | 660 ms | 675 ms |
| `lcu status` | 708 ms | 741 ms | 696 ms | 730 ms |
| `lcu doctor` | 768 ms | 789 ms | 736 ms | 767 ms |
| MCP, Codex registration | 905 ms | 957 ms | 898 ms | 941 ms |
| MCP, Claude Code registration | 899 ms | 947 ms | 886 ms | 938 ms |

### C. TextEdit through real clients

Each client got the same prompt:
- use only the `lcu` `js` tool, menus and clicks, and no letter shortcuts (the keyboard is AZERTY and the UI French);
- take a screenshot and open TextEdit;
- choose "Fichier > Nouveau", then "Format > Convertir au format Texte";
- type `Héllo wörld — 日本語 🚀 Ωμέγα`;
- save through the Save dialog (go-to-folder sheet) to a scratch path;
- quit TextEdit from its menu.

- **Codex CLI.** Command: `codex exec --skip-git-repo-check -C <out> -c 'mcp_servers.lcu.tools.js.approval_mode="approve"'
  -c 'mcp_servers.lcu.tools.js_reset.approval_mode="approve"' -c 'mcp_servers.lcu.env={SKY_CUA_SERVICE_NATIVE_PIPE_PATH="…"}' -`.
  These are command-line overrides only; the scratch config was not edited. Codex passes only its default
  environment to MCP servers, so without the `env` override the first attempt got `Sky Computer Use native pipe
  startup failed`.
  - Result: 18 `js` calls, exit 0. Two calls failed: Finder is not approved, and the state read right after
    "Quitter TextEdit" failed because the process was gone.
- **Claude Code.** Command: `claude -p --allowedTools "mcp__lcu__js,mcp__lcu__js_reset"`, with no other tool
  allowed. Nothing waited on an approval.
  - Result: 21 turns, exit 0.
  - One `click` that opened the Save sheet returned `Sky Computer Use native pipe closed before response`; the next
    call read the open sheet.
  - The model entered the text with `paste`, which **overwrote the user's real clipboard**. Later runs avoid
    clipboard writes.
- **Minimal MCP client (control).** Through the Claude Code registration, scripted step by step:
  - `typeText`, then `setValue` for the exact text;
  - the go-to-folder sheet;
  - "Enregistrer", then "Quitter TextEdit".

All three files are the same 43 bytes, with no trailing newline:

~~~
00000000: 48c3 a96c 6c6f 2077 c3b6 726c 6420 e280  H..llo w..rld ..
00000010: 9420 e697 a5e6 9cac e8aa 9e20 f09f 9a80  . ......... ....
00000020: 20ce a9ce bcce adce b3ce b1               ..........
~~~

Afterwards TextEdit was not running and no dialog was left. TextEdit's iCloud autosave folder was empty. A file of
the user's that TextEdit reopened on launch (`cxbottle.conf`) kept its modification date.

**`typeText` under the French AZERTY layout loses characters in the original runtime.** The same string came out
as `Héllo wrld —   Ω`, `Hello wild —   Ω` or `Héllo wild —   Ω` in different tries. 0.9.7, through its own
relay and runtime, gave the same three results in three tries. LCU's macOS path does not touch text input. Codex
corrected the text with `setValue`, Claude Code used `paste`, and the control used `setValue`.

### D. Lifecycle

Each run started a `js` call that waits 60 s. While it was in flight, the client got the signal or its stdin
closed, and every process it had started was polled every 0.25 s.

**Bug fixed.** With a call in flight, killing Claude Code (SIGINT, SIGTERM or SIGKILL) left the Claude relay and the
original runtime running until the call ended. That was 60 s here; the earlier run measured 22 s. The relay then
crashed with `EPIPE` writing the result to the dead client. 0.9.7 does the same: its relay was still alive at 40 s
in all three cases.

Cause: on stdin EOF the relay drained Interrupt cleanup before closing its server, so the call was never cancelled,
and the original `turn_ended` does not return while the call runs.

Commit `a5bc374` (`fix(claude): end the relay within seconds when its host goes away`) changes the shutdown:
1. Close the server first. That aborts in-flight calls, which cancels them upstream and starts their Interrupt
   cleanup.
2. Give the shutdown drain at most 2 s, then close the original server anyway.

Everything else is unchanged. `adapters/test/claude.test.mjs` has a new test: the relay gets only stdin EOF, with a
call that ignores cancellation and a `turn_ended` that never returns. It fails on the previous relay (still running
after 10 s) and passes now; the cancel and the Interrupt cleanup are both logged before the original server exits.

Time until every process that client started had exited, after the fix:

| Client | SIGINT | SIGTERM | SIGKILL | stdin closed |
| --- | --- | --- | --- | --- |
| Minimal client, Claude Code registration | 7.3 s | 7.4 s | 7.4 s | 6.8 s |
| Real Claude Code | 5.3 s | 5.0 s | 7.2 s | client finishes its turn first (by design) |
| Minimal client, Codex registration | 5.2 s | 5.3 s | 5.3 s | 5.3 s |
| Real Codex CLI | 1.4 s | 0.3 s | 5.3 s | n/a (`codex exec` reads its prompt to EOF) |

The 5 s left after the 2 s drain are the original runtime's own exit when the MCP SDK closes it: stdin EOF, then
SIGTERM after 2 s. It is the same for the Codex relay. Example, the real Claude Code SIGKILL: 9 processes before the
signal (client, `adapters/claude.mjs`, `lcu/runtime.mjs`, `cua-repl.mjs`, `node_repl`, two `codex sandbox`,
`kernel.js`, `trusted-worker.js`); 8 at 3.1 s; 7 at 5.0 s (`runtime.mjs` gone); none at 7.2 s.

Real Codex shows `hook: Interrupt Failed` after SIGINT. The same happens with the registration pointed at 0.9.7, and
`adapters/codex.mjs` is byte-identical to 0.9.7's.

### E. Concurrency

A Codex CLI session and a Claude Code session ran at the same time. Each did `getState`, a count, `js_reset`,
`getState`, a TextEdit screenshot (146351 bytes) and a count. Meanwhile `lcu status` and `lcu doctor` each ran 38
times, all exit 0. Both sessions finished, exit 0.

Claude Code's first `getApp('TextEdit')` returned `-10005 timeoutReached` while Codex was launching TextEdit; its
retry worked. `js_reset` answered `js kernel reset`, and the state after it was fresh.

### F. Upgrade from 0.9.7, inside the window below

1. 0.9.7 `install.sh --runtime-only` into a scratch prefix.
2. **0.9.7's own `lcu setup --prefix <it> --agent codex --agent claude-code --yes`**, run against the real home.
   Both registrations started 0.9.7 and listed tools.
3. **0.9.7's own `lcu update`** through `UPDATE_DRIVER` (`tests/e2e/e2e.py`), with downloads redirected to the local
   archive and its `.sha256`. It ran under `python3 -I` from 0.9.7's interpreter, with the stubs first on `PATH`.
   - Output: `LCU update: 0.9.7 -> 0.10.0`, then `Refreshed the Claude Code lcu-approve mod at ~/.claude/skills/lcu-approve`.
   - `current` → `releases/0.10.0-a64e29df8231`; the 0.9.7 release stayed.
   - The refreshed mod's files are identical to the new release's `adapters/claude-mod/lcu-approve`.
   - Stub log: empty.
4. Through the real home's Codex and Claude Code registrations, the new runtime listed tools in about 870–880 ms and
   took a TextEdit screenshot (JPEG, 146351 bytes), then quit TextEdit.
5. Rollback by reinstalling 0.9.7 runtime-only: `current` → `releases/0.9.7-64262d945858`. `--version`, `status`,
   both tool lists and the screenshot work again.

### G. Setup lock

To keep a holder inside the lock, its `PATH` started with a `codex` shim that sleeps before running the real Codex
CLI. Both versions run `codex --version` inside the lock (the hook-support probe). Once the shim was running under
the holder and `lsof` showed the holder on `setup.lock`, the holder got SIGSTOP. The waiter started 0 s later, and
after 6 s the holder got `kill -9`.

| Home | Holder | Waiter | While held (6 s) | After `kill -9` |
| --- | --- | --- | --- | --- |
| real, in the window | **0.9.7 `lcu setup`** | new `lcu setup` | blocked; `LCU: waiting for another LCU process to release …/setup.lock...`; `lsof`: only the Python holder | exit 0, 1.2 s later |
| real, in the window | new `lcu setup` | **0.9.7 `lcu setup`** | blocked (0.9.7 prints no message); `lsof`: both | exit 0, 1.1 s later |
| scratch | new `lcu setup` | new `lcu setup` | blocked, same message | exit 0, 0.8 s later |

**SIGKILL mid-write.** New-build `lcu setup --agent codex --agent claude-code` in the scratch home got `kill -9` at
0.3, 0.6, 0.9, 1.1, 1.3, 1.5 and 1.7 s; the 1.9–2.4 s runs had already finished. After each, these all parsed, with
`[mcp_servers.lcu]`, `mcpServers.lcu` and the scratch home's own `cli_auth_credentials_store` kept:
- `config.toml`;
- `.claude.json`;
- `settings.json`;
- `setup.json`.

No temporary file was left behind, and a clean rerun exited 0.

### H. Other commands, scratch home

- `lcu update --notice --hook SessionStart` and `UserPromptSubmit`: silent, exit 0, with no newer release. With a
  cached newer release, SessionStart printed the hook JSON `LCU 0.11.0 is available (installed: 0.10.0)…`; that
  cache was restored afterwards.
- `lcu update --check [--json]`: `LCU 0.10.0 is up to date.` (latest published 0.9.7), exit 0.
- `lcu apps list [--json]`: `TextEdit  com.apple.TextEdit`, exit 0.
- `lcu status --json`, `lcu origins list`, `lcu prune`, `lcu doctor`: exit 0.
- `lcu browser status`: exit 1 without Chrome, as with 0.9.7.
- LCU has no uninstall command (uninstall is manual, `docs/INSTALLATION.md`). The reversible part,
  `setup --approval auto` then `--approval ask` for Codex and Claude Code, added exactly the `js`/`js_reset`
  entries. `ask` returned the parsed `[mcp_servers.lcu]` and Claude permissions to their earlier values exactly.

### Tests

These pass after rebasing the fix onto `2e6f094`:
- `node --test tests/node/*.test.mjs`: 369 pass, 29 skipped (Linux-only fakes).
- `npm test` in `adapters`: 129 pass, 8 skipped.
- `python3 -m unittest discover -b -s tests -p 'test_*.py'`: 38 OK.

### Guard and the 0.9.7 window

The guard (above) was run before and after every step.
- It found one change, at 22:59: the user's real LCU went from 0.9.5 to 0.9.7 and its `lcu-approve` mod was
  refreshed.
- The user confirmed they ran `lcu update` themselves at that time. Every process this run started had the scratch
  `HOME`, and the scratch update cache was not written then. The run stopped until the user confirmed, and the
  guard was re-baselined on the updated state.
- Apart from that, real files changed only inside the window the user approved.

**The window** was open from 23:22:06 to 23:25:42.
- Before it: SHA-256 of every file below, plus private copies in a mode-700 scratch directory. For `~/.claude.json`
  only its `mcpServers` were copied.
- Restore: the user's real LCU (0.9.7), `~/.local/share/lcu/current/bin/lcu setup --agent codex --agent claude-code
  --agent omp --yes`, with the real `HOME` and no other flags. It exited 0.
- Result: **every hash matched** and no backup copy was needed. The guard afterwards differed from the baseline only
  in modification times. The real files reference no scratch path.

| File | Before | After |
| --- | --- | --- |
| `~/.codex/config.toml` | `fc36c951c8c4` | `fc36c951c8c4` |
| `~/.codex/hooks.json` | absent | absent |
| `~/.claude/settings.json` | `7c31b7e86651` | `7c31b7e86651` |
| `~/.claude.json` `mcpServers` | `4cbf32db7a87` | `4cbf32db7a87` |
| `~/.claude/skills/lcu-approve/` `plugin.json`, `data.ts`, `hooks.json`, `register.tsx`, `views.tsx`, `lcu.json`, `index.d.ts` | `e8454669…`, `9d22dd68…`, `d842d789…`, `fbe7466d…`, `5ae32325…`, `2eaa9b99…`, `2bb4e2bc…` | same |
| `~/.omp/agent/config.yml` | `fcfaecdcba3c` | `fcfaecdcba3c` |
| `~/.omp/plugins/package.json`, `omp-plugins.lock.json` | `83c737a07eeb`, `f213eb831e1b` | same |
| `~/.omp/plugins/node_modules/lcu-computer-use` | link to `~/.local/share/lcu/omp/user-bbf2b244c46234b8` | same |
| `~/.local/share/lcu/omp/user-bbf2b244c46234b8/` `.lcu-generated.json`, `index.ts`, `package.json` | `3b61ce2f…`, `74962e33…`, `74880719…` | same |
| `~/.local/state/lcu/setup.json`, `approval.json` | `870db6321bcd`, `ca3d163bab05` | same |
| `~/.local/share/lcu/current` | `releases/0.9.7-c063a904d79e` | same |

The approved-app list under the real home was never touched.

## Not verified

- **The task-owned macOS guest** (`docs/verification/macos-test-guest-access.md`). Everything above ran on the user's
  Mac.
- **The Chrome browser relay** on macOS. It was not part of either run.
- **Unicode text entry with `typeText`** on this keyboard layout. It is lossy in the original runtime (0.9.7 too), so
  the exact bytes above came from `setValue` (Codex, control) or `paste` (Claude Code).
- **Closing stdin of a real client mid-call.** Claude Code finishes its turn before exiting, and `codex exec` reads
  its prompt to EOF, so the stdin case of the relay is covered by the minimal client.
- **The first run's gaps are closed by the exhaustive run:** the TextEdit action, real Codex and Claude Code
  sessions, and 0.9.7's own `lcu setup`.
