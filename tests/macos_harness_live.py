#!/usr/bin/env python3
"""Run OMP or Hermes through original macOS CUA in the disposable guest.

This is a real-agent integration runner. It requires the isolated Apple
Virtualization guest, a signed installed ChatGPT app, the guest's installed
LCU release, the official agent CLI, and the task-owned model proxy at
192.168.64.1:62098. No personal profile or provider credential is read.
"""
from __future__ import annotations

import argparse
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import pty
import pwd
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tarfile
import tempfile
import termios
import time
import uuid
from urllib.parse import urlsplit

NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.xz"
NODE_SHA256 = "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe"
NODE_ROOT = Path("/private/tmp/lcu-harness-node-20260928")
NODE_ARCHIVE = NODE_ROOT / "node-v24.21.0-darwin-arm64.tar.xz"
NODE_DIST = NODE_ROOT / "node-v24.21.0-darwin-arm64"
NODE_BIN = NODE_DIST / "bin"


def ensure_node() -> str:
    if getpass.getuser() != "lcuverify":
        raise RuntimeError("Refusing Node setup: expected guest user lcuverify")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Refusing Node setup: expected arm64 macOS")
    hw_model = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.model"], check=True,
                              capture_output=True, text=True).stdout.strip()
    if not hw_model.startswith("VirtualMac"):
        raise RuntimeError("Refusing Node setup: expected a VirtualMac guest")

    node = NODE_BIN / "node"
    npm = NODE_BIN / "npm"
    if node.is_file() and os.access(node, os.X_OK) and npm.exists():
        return str(NODE_BIN)

    NODE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    partial = NODE_ARCHIVE.with_suffix(NODE_ARCHIVE.suffix + ".partial")
    subprocess.run([
        "/usr/bin/curl", "--fail", "--location", "--silent", "--show-error",
        "--output", str(partial), NODE_URL,
    ], check=True, timeout=240)
    digest = hashlib.sha256(partial.read_bytes()).hexdigest()
    if digest != NODE_SHA256:
        partial.unlink(missing_ok=True)
        raise RuntimeError("Official Node archive SHA-256 mismatch")
    os.replace(partial, NODE_ARCHIVE)

    prefix = "node-v24.21.0-darwin-arm64/"
    with tarfile.open(NODE_ARCHIVE, "r:xz") as archive:
        members = archive.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or
                    (member.name.rstrip("/") != NODE_DIST.name and not member.name.startswith(prefix))):
                raise RuntimeError("Unexpected path in official Node archive")
        archive.extractall(NODE_ROOT, members=members, filter="data")

    if not (node.is_file() and os.access(node, os.X_OK) and npm.exists()):
        raise RuntimeError("Official Node archive did not provide node and npm")
    return str(NODE_BIN)


def source_root() -> Path:
    configured = os.environ.get("LCU_SOURCE_ROOT")
    candidates = ([Path(configured)] if configured else []) + list(Path(__file__).resolve().parents)
    for candidate in candidates:
        if (candidate / "lcu/harness_setup.mjs").is_file():
            return candidate.resolve()
    raise SystemExit("Could not locate the LCU source tree; set LCU_SOURCE_ROOT to a tree containing lcu/harness_setup.mjs")


ROOT = source_root()
sys.path.insert(0, str(ROOT / "tests"))
from lcu_node import call, codex_cli  # noqa: E402
def cua_environment(home: Path, app: Path, *, audio: bool = False) -> dict[str, str]:
    resources = app / "Contents/Resources"
    runtime = resources / "cua_node"
    codex = codex_cli(resources, root=ROOT)
    modules = runtime / "lib/node_modules"
    plugins = resources / "plugins"
    helper = modules / "@oai/sky/Codex Computer Use.app"
    codex_home = home / ".codex"
    codex_home.mkdir(parents=True)
    env = {
        "HOME": str(Path.home()), "CODEX_HOME": str(codex_home),
        "PATH": os.pathsep.join((str(Path(sys.executable).parent), str(runtime / "bin"), "/usr/bin", "/bin")),
        "LANG": "C.UTF-8", "TMPDIR": str(home), "CUA_REPL_ENABLED_SURFACES": "computer",
        "SKY_CUA_SERVICE_PATH": str(helper), "NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS": "1000",
        "CUA_REPL_NODE_REPL_PATH": str(runtime / "bin/node_repl"),
        "NODE_REPL_NODE_PATH": str(runtime / "bin/node"),
        "NODE_REPL_NODE_MODULE_DIRS": str(modules),
        "NODE_REPL_TRUSTED_CODE_PATHS": os.pathsep.join((str(codex_home), str(modules), str(plugins))),
        "CODEX_CLI_PATH": str(codex), "NODE_REPL_DISABLE_ANALYTICS": "1",
        "NODE_REPL_REQUEST_META": json.dumps({"x-codex-turn-metadata": {
            "session_id": f"lcu-native-{uuid.uuid4()}", "turn_id": str(uuid.uuid4())}}),
    }
    if audio:
        env["SKY_ENABLE_AUDIO"] = "1"
        env["NODE_REPL_ENABLE_AUDIO"] = "1"
    return env

ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
SCOPES = {"once": 0, "session": 1, "always": 2}
EXPECTED_APP_TEAM = "2DC432GLL2"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def command(argv: list[str], *, env: dict[str, str], cwd: Path,
            timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=timeout,
                          check=False)


def app_identity(app: Path) -> dict:
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.openai.codex":
        raise SystemExit("Selected app is not the official OpenAI desktop bundle")
    verified = subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
                              capture_output=True, text=True, timeout=20)
    display = subprocess.run(["/usr/bin/codesign", "-dv", "--verbose=2", str(app)],
                             capture_output=True, text=True, timeout=20)
    metadata = display.stdout + display.stderr
    identity = next((line.split("=", 1)[1] for line in metadata.splitlines()
                     if line.startswith("Identifier=")), None)
    team = next((line.split("=", 1)[1] for line in metadata.splitlines()
                 if line.startswith("TeamIdentifier=")), None)
    if verified.returncode or identity != "com.openai.codex" or team != EXPECTED_APP_TEAM:
        raise SystemExit("Selected app's official signature verification failed")
    runtime = app / "Contents/Resources/cua_node"
    version_file = runtime / "lib/node_modules/@oai/cua-repl/package.json"
    repl_version = json.loads(version_file.read_text()).get("version") if version_file.is_file() else None
    return {"bundle_id": info["CFBundleIdentifier"],
            "version": info.get("CFBundleShortVersionString"),
            "build": info.get("CFBundleVersion"), "signature_identifier": identity,
            "team_id": team, "cua_runtime_version": repl_version,
            "node_version": command([str(runtime / "bin/node"), "--version"],
                                    env=os.environ.copy(), cwd=ROOT, timeout=10).stdout.strip()}


def select_scope(agent: str, rendered: str, scope: str) -> bool:
    title = "Allow Computer Use to use"
    if agent == "omp":
        target = "Allow for this session" if scope == "session" else "Always allow"
        required = ("Allow once", target, "Always allow", "Decline")
    else:
        target = ("Allow this session", "Allow for this session") if scope == "session" else (
            "Always allow", "Add to permanent allowlist")
        required = ("Allow once", "Deny")
        if not any(label in rendered for label in target):
            return False
    return title in rendered and all(label in rendered for label in required)


def instrument_pi_cleanup(adapter_file: Path) -> None:
    source = adapter_file.read_text(encoding="utf-8")
    anchor = """      await client.turnEnded({ ...cleanup.turn, event: cleanup.event });
      if (pendingCleanup === cleanup) pendingCleanup = undefined;"""
    observer = (
        "      const lifecyclePath = process.env.LCU_PI_LIFECYCLE_LOG;\n"
        "      if (lifecyclePath) appendFileSync(lifecyclePath, JSON.stringify({session_id: cleanup.turn.sessionId, turn_id: cleanup.turn.turnId, event: cleanup.event}) + '\\n');\n"
    )
    import_anchor = "import { randomUUID } from 'node:crypto';"
    if source.count(anchor) != 1 or source.count(import_anchor) != 1:
        raise RuntimeError("Committed OMP finish cleanup anchor changed; refusing to instrument")
    source = source.replace(import_anchor, "import { appendFileSync } from 'node:fs';\n" + import_anchor)
    source = source.replace(anchor, anchor.replace("\n      if (pendingCleanup", "\n" + observer + "      if (pendingCleanup"))
    adapter_file.write_text(source, encoding="utf-8")


def instrument_hermes_cleanup(plugin_file: Path) -> None:
    source = plugin_file.read_text(encoding="utf-8")
    anchor = "            with turn_lock:\n                pending_cleanups.pop((session_id, exact_turn), None)"
    observer = (
        "            lifecycle_path = os.environ.get('LCU_HERMES_LIFECYCLE_LOG')\n"
        "            if lifecycle_path:\n"
        "                with open(lifecycle_path, 'a', encoding='utf-8') as lifecycle_file:\n"
        "                    lifecycle_file.write(json.dumps({'session_id': session_id, 'turn_id': exact_turn, 'event': pending_event or event}) + '\\n')\n"
    )
    if source.count(anchor) != 1:
        raise RuntimeError("Hermes generated adapter cleanup anchor changed; refusing to instrument")
    plugin_file.write_text(source.replace(anchor, observer + anchor), encoding="utf-8")


def prepare_runtime_overlay(stage: Path, installed_root: Path, destination: Path) -> Path:
    """Run staged LCU code against the app already selected by the guest install."""
    destination.mkdir(parents=True)
    shutil.copytree(stage / "lcu", destination / "lcu")
    shutil.copytree(stage / "adapters", destination / "adapters",
                    ignore=shutil.ignore_patterns("node_modules"))
    (destination / "bin").mkdir()
    shutil.copy2(stage / "bin/lcu", destination / "bin/lcu")
    (destination / "bin/lcu").chmod(0o755)
    for name in ("bundle.json", "installation.json", "runtime.lock.json"):
        source = installed_root / name
        if source.is_file():
            shutil.copy2(source, destination / name)
    selected_app = installed_root / "app"
    if not selected_app.exists():
        raise SystemExit("Installed LCU release has no selected app link")
    (destination / "app").symlink_to(selected_app.resolve(strict=True), target_is_directory=True)
    dependencies = installed_root / "adapters/node_modules"
    if not dependencies.is_dir():
        raise SystemExit("Installed LCU adapter dependencies are missing")
    (destination / "adapters/node_modules").symlink_to(dependencies, target_is_directory=True)
    return destination / "bin/lcu"


def instrument_client_trace(client_file: Path) -> None:
    source = client_file.read_text(encoding="utf-8")
    fs_import = "import { chmodSync, mkdtempSync, rmSync } from 'node:fs';"
    marker = "const MODEL_TOOLS = new Set(['js', 'js_reset']);"
    if source.count(fs_import) != 1 or source.count(marker) != 1:
        raise RuntimeError("Committed MCP client trace preamble changed; refusing to instrument")
    source = source.replace(fs_import, "import { appendFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';")
    trace = marker + "\nconst nativeTrace = row => { const path = process.env.LCU_NATIVE_TRACE; if (path) appendFileSync(path, JSON.stringify(row) + '\\n'); };"
    source = source.replace(marker, trace)

    elicitation = "    const answer = await onElicitation(params);"
    elicitation_trace = elicitation + "\n    nativeTrace({kind: 'elicitation', app_id: params?._meta?.tool_params?.app ?? null, action: answer?.action ?? 'cancel', persist: answer?._meta?.persist ?? (answer?.action === 'accept' ? 'once' : null)});"
    if source.count(elicitation) != 1:
        raise RuntimeError("Committed MCP elicitation seam changed; refusing to instrument")
    source = source.replace(elicitation, elicitation_trace)

    call_anchor = """      return client.callTool({ name, arguments: args, _meta: {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        'x-codex-turn-metadata': turnMetadata,
      } }, undefined, { signal, timeout });"""
    call_trace = """      const result = await client.callTool({ name, arguments: args, _meta: {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        'x-codex-turn-metadata': turnMetadata,
      } }, undefined, { signal, timeout });
      nativeTrace({kind: 'tool_call', tool: name, session_id: turnMetadata.session_id,
        turn_id: turnMetadata.turn_id, is_error: Boolean(result.isError)});
      return result;"""
    if source.count(call_anchor) != 1:
        raise RuntimeError("Committed MCP metadata forwarding seam changed; refusing to instrument")
    source = source.replace(call_anchor, call_trace)

    stop_anchor = r"""      if (result.isError) {
        const detail = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        throw new Error(`Original CUA turn cleanup failed: ${detail || 'unknown error'}`);
      }
      return result;
    },
    get hasHostControl()"""
    stop_trace = r"""      if (result.isError) {
        const detail = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        throw new Error(`Original CUA turn cleanup failed: ${detail || 'unknown error'}`);
      }
      nativeTrace({kind: 'turn_ended', session_id: sessionId, turn_id: turnId, event});
      return result;
    },
    get hasHostControl()"""
    if source.count(stop_anchor) != 1:
        raise RuntimeError("Committed MCP turn-ended seam changed; refusing to instrument")
    client_file.write_text(source.replace(stop_anchor, stop_trace), encoding="utf-8")


def terminate_process(process: subprocess.Popen | None) -> None:
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return

    # The leader can exit before descendants. Keep checking the whole group,
    # treating zombies as gone because only their parent can reap them.
    def live_group_members() -> bool:
        result = subprocess.run(["ps", "-axo", "pgid=,stat="], capture_output=True,
                                text=True, check=True)
        return any(int(fields[0]) == process.pid and "Z" not in fields[1]
                   for line in result.stdout.splitlines()
                   if len(fields := line.split()) == 2)

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if process.poll() is None:
            try:
                process.wait(timeout=.05)
            except subprocess.TimeoutExpired:
                pass
        if not live_group_members():
            return
        time.sleep(.05)

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if process.poll() is None:
        process.wait(5)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not live_group_members():
            return
        time.sleep(.05)
    raise TimeoutError(f"Agent process group {process.pid} remained alive after SIGKILL")


def stop_fixture(pid_path: Path | None, pid: int | None) -> None:
    if pid is None and pid_path is not None and pid_path.is_file():
        try:
            pid = int(pid_path.read_text().strip())
        except (OSError, ValueError):
            pid = None
    if pid is None:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def build_command(agent: str, cli: Path, model: str, args: list[str], prompt: str) -> list[str]:
    if agent == "omp":
        return [str(cli), "--no-session", "--no-title", "--tools=js,js_reset",
                "--model", "openai/" + model, "--api-key", "local-fixture-proxy",
                "--thinking=low", *args, prompt]
    return [str(cli), "chat", "--tui", "--provider", "custom", "--model", model,
            "--toolsets", "lcu_cua", "--max-turns", "12", *args, "-q", prompt]


def prompt_for(agent: str, bundle_id: str, marker: str) -> str:
    return ("Use only the original Computer Use js tool. First call js once "
            "with `await cua.getState();` to read the original instructions and identify the "
            "fixture window. Then make a separate js call to set its Draft text field to exactly "
            f"{marker}, click Save draft, and read the field once after saving. Confirm the field "
            f"contains {marker} and stop; this fixture has no Saved label. The target app bundle "
            f"identifier is {bundle_id}. Do not use shell, terminal, filesystem, browser, or other "
            "tools. Do not repeat inspection after the field contains the marker.")


def run_phase(*, agent: str, cli: Path, model: str, args: list[str], prompt: str,
              env: dict[str, str], cwd: Path, oracle: Path, marker: str, scope: str,
              allow_approval: bool, expect_approval: bool, phase_timeout: int, trace_path: Path,
              lifecycle_path: Path, terminal_log_path: Path) -> dict:
    master = slave = None
    process = None
    captured = bytearray()
    selected = False
    unexpected_approval = False
    hermes_fallback_sent = False
    hermes_fallback_return_pending = False

    def read_jsonl(path: Path) -> list[dict]:
        try:
            return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
        except (OSError, json.JSONDecodeError):
            return []

    def diagnostic() -> dict:
        try:
            oracle_text = oracle.read_text(encoding="utf-8") if oracle.is_file() else None
        except OSError as exc:
            oracle_text = f"<read error: {exc}>"
        return {
            "selected": selected,
            "hermes_startup_query_replayed": hermes_fallback_sent,
            "unexpected_approval": unexpected_approval,
            "saved": oracle_text == marker,
            "oracle_text": oracle_text,
            "tool_trace": read_jsonl(trace_path),
            "lifecycle_trace": read_jsonl(lifecycle_path),
            "terminal_output": ANSI.sub("", captured.decode("utf-8", "replace"))[-10000:],
            "terminal_log_path": str(terminal_log_path),
        }

    try:
        try:
            oracle.unlink(missing_ok=True)
        except OSError:
            pass
        commandline = build_command(agent, cli, model, args, prompt)
        terminal_log_path.parent.mkdir(parents=True, exist_ok=True)
        terminal_log_path.write_text("", encoding="utf-8")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 160, 0, 0))
        process = subprocess.Popen(commandline, stdin=slave, stdout=slave, stderr=slave,
            cwd=cwd, env=env, start_new_session=True, close_fds=True)
        os.close(slave)
        slave = None
        deadline = time.monotonic() + phase_timeout
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if data:
                    captured.extend(data)
                    # Flush each PTY chunk so a host-side guest watcher can inspect a stalled run.
                    with terminal_log_path.open("a", encoding="utf-8") as terminal_log:
                        terminal_log.write(data.decode("utf-8", "replace"))
                        terminal_log.flush()
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
            rendered = ANSI.sub("", captured.decode("utf-8", "replace"))
            # Hermes' --tui -q startup submit waits at most 4 s for a session.
            # If session.create is slower, submit the same prompt through the
            # focused composer once the UI reports both the skipped query and
            # a ready session. This is a test-runner fallback, not an adapter
            # or upstream runtime change.
            if (agent == "hermes" and not hermes_fallback_sent and
                    "startupqueryskipped:noactivesession" in re.sub(r"\s+", "", rendered) and
                    re.search(r"\bready\b", rendered) and
                    re.search(r"\b\d+ sessions?\b", rendered)):
                os.write(master, b"\x1b[200~" + prompt.encode("utf-8") + b"\x1b[201~")
                hermes_fallback_sent = True
                hermes_fallback_return_pending = True
            elif agent == "hermes" and hermes_fallback_return_pending:
                # Give the Ink composer one PTY read/React turn to process the
                # bracketed paste before submitting it with the ordinary Enter.
                os.write(master, b"\r")
                hermes_fallback_return_pending = False
            if not selected and select_scope(agent, rendered, scope):
                if not allow_approval:
                    unexpected_approval = True
                    break
                offset = SCOPES[scope]
                if agent == "hermes":
                    os.write(master, str(offset + 1).encode())
                else:
                    if offset:
                        os.write(master, b"\x1b[B" * offset)
                    os.write(master, b"\r")
                selected = True
                allow_approval = False
            marker_saved = oracle.is_file() and oracle.read_text(encoding="utf-8") == marker
            lifecycle = read_jsonl(lifecycle_path)
            stopped = any(row.get("event") == "Stop" for row in lifecycle)
            if marker_saved and stopped:
                break
            if process.poll() is not None:
                break
        else:
            raise TimeoutError("Agent phase exceeded its per-process timeout")

        trace = read_jsonl(trace_path)
        calls = [row for row in trace if row.get("kind") == "tool_call" and row.get("tool") == "js"]
        approvals = [row for row in trace if row.get("kind") == "elicitation"]
        stops = [row for row in trace if row.get("kind") == "turn_ended" and row.get("event") == "Stop"]
        saved = oracle.is_file() and oracle.read_text(encoding="utf-8") == marker
        sessions = sorted({row.get("session_id") for row in calls if row.get("session_id")})
        turns = sorted({row.get("turn_id") for row in calls if row.get("turn_id")})
        result = {"marker": marker, "saved": saved, "approval_selected": selected,
                  "hermes_startup_query_replayed": hermes_fallback_sent,
                  "approval_records": approvals, "js_call_count": len(calls),
                  "tool_trace": trace, "stop_events": stops, "session_ids": sessions,
                  "turn_ids": turns, "agent_pid": process.pid,
                  "terminal_output": ANSI.sub("", captured.decode("utf-8", "replace"))[-10000:],
                  "terminal_log_path": str(terminal_log_path)}
        if unexpected_approval:
            raise AssertionError("Unexpected native approval prompt in the fresh-process reuse phase")
        if len(calls) < 2:
            raise AssertionError("Expected distinct initial-state and action js calls")
        if not saved or not stops:
            raise AssertionError("Agent did not save the independent marker and complete original Stop")
        if expect_approval and not selected:
            raise AssertionError("Expected native approval selector was not selected")
        if not expect_approval and approvals:
            raise AssertionError("Fresh process unexpectedly requested native approval")
        expected_persist = scope if selected and scope in ("session", "always") else None
        if selected and (len(approvals) != 1 or approvals[0].get("persist") != expected_persist):
            raise AssertionError(f"Expected exactly one {expected_persist} approval response")
        return result
    except BaseException as exc:
        try:
            setattr(exc, "phase_evidence", diagnostic())
        except Exception:
            pass
        raise
    finally:
        terminate_process(process)
        if master is not None:
            try:
                os.close(master)
            except OSError:
                pass
        if slave is not None:
            try:
                os.close(slave)
            except OSError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a native app scope and fresh-process reuse check.")
    parser.add_argument("--agent", choices=("omp", "hermes"), required=True)
    parser.add_argument("--cli", required=True, type=Path)
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--runtime", type=Path, default=Path("/Users/lcuverify/lcu-installed/current/bin/lcu"))
    parser.add_argument("--app", type=Path, default=Path("/Applications/ChatGPT.app"))
    parser.add_argument("--model", default="glm-5.3-flash")
    parser.add_argument("--base-url", default="http://192.168.64.1:62098/v1")
    parser.add_argument("--scope", choices=("session", "always"), required=True)
    parser.add_argument("--expected-user", default="lcuverify")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("Refusing native UI test outside the Apple Silicon macOS guest")
    if pwd.getpwuid(os.getuid()).pw_name != args.expected_user:
        raise SystemExit("Refusing native UI test under an unexpected guest account")
    hw = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.model"], capture_output=True,
                        text=True, timeout=5, check=True).stdout.strip()
    if not hw.startswith("VirtualMac"):
        raise SystemExit("Refusing native UI test outside Apple Virtualization hardware")
    cli, release, runtime, app = (args.cli.resolve(strict=True), args.release.resolve(strict=True),
                                  args.runtime.resolve(strict=True), args.app.resolve(strict=True))
    if not all((release / path).is_file() for path in
               ("bin/lcu", "lcu/runtime.mjs", "adapters/pi/index.ts", "adapters/hermes/plugin.yaml")):
        raise SystemExit("Staged LCU source tree is incomplete")
    url = urlsplit(args.base_url)
    if (url.scheme != "http" or url.hostname != "192.168.64.1" or url.port != 62098 or
            url.path.rstrip("/") != "/v1" or url.username or url.password or url.query or url.fragment):
        raise SystemExit("Provider must use the task-owned model bridge")
    app_report = app_identity(app)
    cli_version = command([str(cli), "--version"], env=os.environ.copy(), cwd=ROOT, timeout=20)
    if cli_version.returncode:
        raise SystemExit("Selected agent CLI version probe failed")
    overall_deadline = time.monotonic() + args.timeout
    temp_parent = "/private/tmp"
    phase_results = []
    failure = None
    fixture_pid = None
    pid_path = None
    process_count = 2 if args.scope == "always" else 1
    markers = [f"lcu-{args.agent}-{uuid.uuid4().hex[:12]}" for _ in range(process_count)]
    try:
        with tempfile.TemporaryDirectory(prefix=f"lcu-{args.agent}-scopes-", dir=temp_parent) as temporary:
            root = Path(temporary)
            overlay_runtime = prepare_runtime_overlay(release, runtime.parent.parent, root / "live-lcu")
            home, hermes_home = root / "home", root / "hermes-home"
            for directory in (home, hermes_home, root / "cwd", root / "session"):
                directory.mkdir(parents=True)
            env = cua_environment(home, app, audio=False)
            env["PATH"] = os.pathsep.join((str(cli.parent), env.get("PATH", "/usr/bin:/bin")))
            if args.agent == "hermes":
                env["PATH"] = ensure_node() + os.pathsep + env["PATH"]
            env.update({"HOME": str(home), "HERMES_HOME": str(hermes_home),
                        "OPENAI_API_KEY": "local-fixture-proxy", "TERM": "xterm-256color",
                        "NO_COLOR": "1", "NO_PROXY": "localhost,127.0.0.1,192.168.64.1",
                        "no_proxy": "localhost,127.0.0.1,192.168.64.1"})
            fixture_root = root / "fixture"
            fixture_root.mkdir()
            pid_path = fixture_root / "fixture.pid"
            env["LCU_FIXTURE_PID_FILE"] = str(pid_path)
            lifecycle_path = root / "turn-ended.jsonl"
            env.update({"LCU_PI_LIFECYCLE_LOG": str(lifecycle_path),
                        "LCU_HERMES_LIFECYCLE_LOG": str(lifecycle_path)})
            try:
                subprocess.run([str(ROOT / "tests/macos_native_fixture.sh"), str(fixture_root)],
                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=90, check=True)
                deadline = time.monotonic() + 10
                while not pid_path.is_file() and time.monotonic() < deadline:
                    time.sleep(.1)
                if not pid_path.is_file():
                    raise RuntimeError("Generated fixture did not report its process ID")
                fixture_pid = int(pid_path.read_text().strip())
                app_fixture = fixture_root / "LCUMacFixture.app"
                bundle_id = plistlib.loads((app_fixture / "Contents/Info.plist").read_bytes())["CFBundleIdentifier"]
                oracle = fixture_root / "draft.txt"
                test_release = root / "release"
                shutil.copytree(release / "adapters", test_release / "adapters",
                                ignore=shutil.ignore_patterns("node_modules"))
                deps = runtime.parent.parent / "adapters/node_modules"
                if not deps.is_dir():
                    raise SystemExit("Installed LCU adapter dependencies are missing")
                (test_release / "adapters/node_modules").symlink_to(deps, target_is_directory=True)
                instrument_client_trace(test_release / "adapters/client.mjs")
                if args.agent == "omp":
                    instrument_pi_cleanup(test_release / "adapters/pi/index.ts")
                    profile = home / ".omp/profiles/lcu-macos/agent"
                    profile.mkdir(parents=True)
                    env.update({"OMP_PROFILE": "lcu-macos", "PI_PROFILE": "lcu-macos",
                                "PI_CODING_AGENT_DIR": str(profile)})
                    (profile / "models.yml").write_text(
                        "providers:\n  openai:\n    api: openai-completions\n"
                        f"    baseUrl: {args.base_url.rstrip('/')}\n"
                        "    apiKey: local-fixture-proxy\n    models:\n"
                        f"      - id: {args.model}\n        contextWindow: 200000\n"
                        "        maxTokens: 8192\n        supportsTools: true\n"
                        "        compat:\n          supportsDeveloperRole: false\n", encoding="utf-8")
                    call("harness_setup", "configureOmp", home,
                         ["/usr/bin/env", f"HOME={Path.home()}", str(overlay_runtime)],
                         test_release, {"scope": "user", "env": env}, root=ROOT)
                    (profile / "config.yml").write_text("setupVersion: 2\nstartup:\n  quiet: true\n")
                    run_args = ["--cwd", str(root / "cwd"), "--session-dir", str(root / "session")]
                else:
                    node = app / "Contents/Resources/cua_node/bin/node"
                    call("harness_setup", "configureHermes", home,
                         ["/usr/bin/env", f"HOME={Path.home()}", str(overlay_runtime)],
                         node, test_release, {"scope": "user", "env": env}, root=ROOT)
                    instrument_hermes_cleanup(hermes_home / "plugins/lcu-cua/__init__.py")
                    for key, value in (("model.provider", "custom"), ("model.default", args.model),
                        ("model.base_url", args.base_url.rstrip("/")), ("model.api_mode", "chat_completions"),
                        ("agent.max_turns", "12"), ("tools.tool_search.enabled", "off")):
                        subprocess.run([str(cli), "config", "set", key, value], cwd=home, env=env,
                                       check=True, timeout=120)
                    run_args = []
                for index, marker in enumerate(markers):
                    phase = f"process-{index + 1}"
                    trace_path = root / f"{phase}-trace.jsonl"
                    phase_lifecycle = root / f"{phase}-turn-ended.jsonl"
                    env["LCU_NATIVE_TRACE"] = str(trace_path)
                    env["LCU_PI_LIFECYCLE_LOG"] = str(phase_lifecycle)
                    env["LCU_HERMES_LIFECYCLE_LOG"] = str(phase_lifecycle)
                    prompt = prompt_for(args.agent, bundle_id, marker)
                    phase_scope = args.scope if index == 0 else "always"
                    try:
                        remaining = int(overall_deadline - time.monotonic())
                        if remaining <= 0:
                            raise TimeoutError("Overall scope check exceeded --timeout")
                        record = run_phase(agent=args.agent, cli=cli, model=args.model, args=run_args,
                            prompt=prompt, env=env, cwd=root / "cwd", oracle=oracle, marker=marker,
                            scope=phase_scope, allow_approval=(index == 0), expect_approval=(index == 0),
                            phase_timeout=remaining, trace_path=trace_path, lifecycle_path=phase_lifecycle,
                            terminal_log_path=root / f"{phase}-terminal.log")
                        record["phase"] = phase
                        record["selected_scope"] = phase_scope if index == 0 else None
                        record["app_pid"] = fixture_pid
                        record["bundle_id"] = bundle_id
                        phase_results.append(record)
                    except BaseException as exc:
                        failure = f"{type(exc).__name__}: {exc}"
                        diagnostic = getattr(exc, "phase_evidence", None)
                        phase_results.append({"phase": phase, "failure": failure,
                                              "diagnostic": diagnostic})
                        raise
                if args.scope == "always":
                    first, second = phase_results
                    if first["bundle_id"] != second["bundle_id"] or first["app_pid"] != second["app_pid"]:
                        raise AssertionError("Fresh-process check did not reuse the same generated app")
                    if (len(first["session_ids"]) != 1 or len(second["session_ids"]) != 1 or
                            len(first["turn_ids"]) != 1 or len(second["turn_ids"]) != 1 or
                            set(first["session_ids"]) & set(second["session_ids"]) or
                            set(first["turn_ids"]) & set(second["turn_ids"])):
                        raise AssertionError("The second process did not create one fresh agent session and turn")
            except BaseException as exc:
                if failure is None:
                    failure = f"{type(exc).__name__}: {exc}"
            finally:
                stop_fixture(pid_path, fixture_pid)
                evidence = {
                    "result": "passed" if failure is None and len(phase_results) == process_count else "failed",
                    "agent": args.agent, "agent_version": (cli_version.stdout or cli_version.stderr).strip(),
                    "agent_sha256": sha256_file(cli), "scope_mode": args.scope,
                    "model": args.model, "proxy_origin": f"{url.scheme}://{url.netloc}",
                    "app": app_report, "same_generated_app": process_count == 1 or
                        (len(phase_results) == 2 and phase_results[0].get("bundle_id") == phase_results[1].get("bundle_id")
                         and phase_results[0].get("app_pid") == phase_results[1].get("app_pid")),
                    "phases": phase_results, "failure": failure,
                }
                evidence_path = args.evidence.expanduser().resolve()
                evidence_path.parent.mkdir(parents=True, exist_ok=True)
                evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    except BaseException as exc:
        failure = failure or f"{type(exc).__name__}: {exc}"
        if "evidence" in locals() and "evidence_path" in locals():
            evidence["result"] = "failed"
            evidence["failure"] = failure
            evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    if failure:
        raise SystemExit(failure)
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
