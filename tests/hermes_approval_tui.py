"""Exercise the real Hermes TUI approval callback through an LCU MCP tool call.

Uses a local scripted OpenAI-compatible provider, the generated Hermes plugin,
and a synthetic MCP fixture. No real model, credential, desktop, or user profile.
"""
from __future__ import annotations

import argparse
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
from lcu_node import call  # noqa: E402

ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
TEMP_PARENT = "/private/tmp" if sys.platform == "darwin" else "/tmp"
CASES = [
    ("once", "approval-native", 0, {"action": "accept", "content": {}}),
    ("session", "approval-native", 1,
     {"action": "accept", "content": {}, "_meta": {"persist": "session"}}),
    ("always", "approval-native", 2,
     {"action": "accept", "content": {}, "_meta": {"persist": "always"}}),
    ("deny", "approval-native", 3, {"action": "decline"}),
    ("cancel", "approval-native", None, {"action": "cancel"}),
    ("tui-ctrlc", "approval-native", "ctrl-c", {"action": "decline"}),
    ("session-only", "approval-native-session-only", 1,
     {"action": "accept", "content": {}, "_meta": {"persist": "session"}}),
]


def exercise(hermes: Path, node: Path, release: Path, name: str,
             code: str, selection: int | str | None, expected: dict, evidence_dir: Path) -> dict:
    requests = []
    model_requests = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            tools = body.get("tools") if isinstance(body.get("tools"), list) else []
            has_lcu_tool = any(item.get("function", {}).get("name") == "js"
                               for item in tools if isinstance(item, dict))
            if not has_lcu_tool:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"id": "fixture-title", "object": "chat.completion",
                    "created": 1, "model": "fixture", "choices": [{"index": 0,
                    "message": {"role": "assistant", "content": "LCU approval"},
                    "finish_reason": "stop"}]}).encode())
                return
            model_requests.append(body)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            common = {"id": "lcu-hermes-approval", "object": "chat.completion.chunk",
                      "created": 1, "model": "fixture"}
            if len(model_requests) == 1:
                delta = {"role": "assistant", "tool_calls": [{
                    "index": 0, "id": "approval-call", "type": "function",
                    "function": {"name": "js", "arguments": json.dumps({"code": code})},
                }]}
                finish = "tool_calls"
            else:
                delta = {"role": "assistant", "content": "Approval fixture completed."}
                finish = "stop"
            for chunk in (
                {**common, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
            ):
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    captured = bytearray()
    selected = False
    with tempfile.TemporaryDirectory(prefix="lcu-hermes-tui-", dir=TEMP_PARENT) as temporary:
        root = Path(temporary)
        home, hermes_home, cwd = root / "home", root / "hermes", root / "cwd"
        home.mkdir()
        hermes_home.mkdir()
        cwd.mkdir()
        log = root / "mcp.jsonl"
        env = {
            "PATH": os.pathsep.join((str(hermes.parent), str(node.parent), "/usr/bin", "/bin")),
            "HOME": str(home), "HERMES_HOME": str(hermes_home),
            "OPENAI_API_KEY": "lcu-hermes-scripted-provider", "TERM": "xterm-256color",
            "NO_COLOR": "1", "LCU_FIXTURE_LOG": str(log),
        }
        call("harness_setup", "configureHermes", home,
             [str(node), str(ROOT / "adapters/test/hermes-mcp-fixture.mjs")],
             node, release, {"scope": "user", "env": env})
        settings = [
            ("model.provider", "custom"), ("model.default", "fixture"),
            ("model.base_url", f"http://127.0.0.1:{server.server_port}/v1"),
            ("model.api_mode", "chat_completions"), ("agent.max_turns", "4"),
            ("tools.tool_search.enabled", "off"),
        ]
        if selection is None:
            settings.append(("approvals.timeout", "2"))
        for key, value in settings:
            configured = subprocess.run([str(hermes), "config", "set", key, value],
                                         cwd=home, env=env, capture_output=True, text=True, timeout=20)
            if configured.returncode:
                raise AssertionError(f"Hermes config {key} failed: {configured.stderr}{configured.stdout}")

        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
        process = subprocess.Popen(
            [str(hermes), "chat", "--tui", "-q", "Call the generated js approval fixture.",
             "--provider", "custom", "--model", "fixture", "--toolsets", "lcu_cua",
             "--max-turns", "4"],
            stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env, start_new_session=True)
        os.close(slave)
        try:
            deadline = time.monotonic() + 50
            while time.monotonic() < deadline:
                if select.select([master], [], [], .05)[0]:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError:
                        break
                rendered = ANSI.sub("", captured.decode("utf-8", "replace"))
                visible = ("Allow Computer Use to use \"Fixture App\"?" in rendered and
                           "Allow once" in rendered and "Deny" in rendered)
                if not selected and visible:
                    if code == "approval-native-session-only" and (
                            "Allow this session" not in rendered or "Always allow" in rendered):
                        raise AssertionError("Hermes showed a scope not offered by original runtime")
                    selected = True
                    if selection == "ctrl-c":
                        os.write(master, b"\x03")
                    elif selection is not None:
                        # Hermes advertises 1-4 quick-pick bindings; send one key
                        # instead of batching cursor motion and Enter through PTY.
                        os.write(master, str(selection + 1).encode())
                records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
                decision_event = next((row for row in records if row.get("name") == "elicitation-result"), None)
                cleanup = next((row for row in records if row.get("name") == "turn_ended"), None)
                if decision_event and cleanup:
                    break
                if process.poll() is not None and decision_event:
                    break
            records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            decision_event = next((row for row in records if row.get("name") == "elicitation-result"), None)
            cleanup = next((row for row in records if row.get("name") == "turn_ended"), None)
            actual = decision_event.get("decision") if decision_event else None
            if not selected:
                raise AssertionError(f"Hermes TUI did not present its native approval selector:\n{rendered}")
            if actual != expected:
                raise AssertionError(f"{name}: expected {expected}, got {actual}; terminal:\n{rendered}")
            if not cleanup:
                raise AssertionError(f"{name}: Hermes did not send original turn cleanup; terminal:\n{rendered}")
            return {"case": name, "decision": actual, "selector_seen": True,
                    "cleanup_event": cleanup.get("args", {}).get("hook_event_name"),
                    "provider_requests": len(requests)}
        finally:
            evidence_dir.mkdir(parents=True, exist_ok=True)
            (evidence_dir / f"{name}.terminal.txt").write_text(
                ANSI.sub("", captured.decode("utf-8", "replace")), encoding="utf-8")
            (evidence_dir / f"{name}.provider.json").write_text(
                json.dumps(requests, indent=2) + "\n", encoding="utf-8")
            if log.exists():
                shutil.copy2(log, evidence_dir / f"{name}.mcp.jsonl")
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(5)
            os.close(master)
            server.shutdown()
            server.server_close()
            worker.join(2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--release", type=Path, default=ROOT)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--case", choices=[case[0] for case in CASES])
    args = parser.parse_args()
    hermes, node, release = args.hermes.absolute(), args.node.absolute(), args.release.absolute()
    if not all(path.is_file() for path in (hermes, node)):
        parser.error("--hermes and --node must name existing files")
    reports = []
    for name, code, selection, expected in CASES:
        if args.case and args.case != name:
            continue
        report = exercise(hermes, node, release, name, code, selection, expected, args.evidence)
        reports.append(report)
        print(json.dumps(report), flush=True)
    (args.evidence / "summary.json").write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
