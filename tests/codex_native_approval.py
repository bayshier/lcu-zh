"""Interactively probe the pinned Codex CLI's native-app approval response.

The CLI, MCP SDK service, model endpoint, HOME, and CODEX_HOME are isolated.
The named app bundle ID is synthetic; the fixture never opens an app or invokes
computer-use operations. The user chooses the approval option in the Codex TUI.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import uuid


ROOT = Path(__file__).resolve().parents[1]
MCP_FIXTURE = ROOT / "adapters/test/codex_native_approval_fixture.mjs"


def quote(value):
    return json.dumps(str(value), ensure_ascii=False)


def write_config(config, project, node, port, log, app, session_id, turn_id):
    lines = [
        'approval_policy = "on-request"',
        'sandbox_mode = "read-only"',
        'model_provider = "fixture"',
        'model = "fixture"',
        "",
        f"[projects.{quote(project)}]",
        'trust_level = "trusted"',
        "",
        "[mcp_servers.fixture]",
        "required = true",
        f"command = {quote(node)}",
        f"args = [{quote(MCP_FIXTURE)}]",
        "startup_timeout_sec = 10",
        "",
        "[mcp_servers.fixture.env]",
        f"LCU_APPROVAL_LOG = {quote(log)}",
        f"LCU_FIXTURE_APP = {quote(app)}",
        f"LCU_FIXTURE_SESSION = {quote(session_id)}",
        f"LCU_FIXTURE_TURN = {quote(turn_id)}",
        "",
        "[mcp_servers.fixture.tools.native_app]",
        'approval_mode = "approve"',
        "output_token_limit = 1000",
        "",
        "[model_providers.fixture]",
        'name = "Local approval fixture"',
        f'base_url = "http://127.0.0.1:{port}/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "",
        "[tui]",
        "screen_reader_detection_done = true",
        "",
    ]
    config.write_text("\n".join(lines), encoding="utf-8")


def run(cli):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node must be on PATH; install adapters dependencies first")
    if not (ROOT / "adapters/node_modules/@modelcontextprotocol/sdk").exists():
        raise RuntimeError("install the official SDK with npm ci --prefix adapters --ignore-scripts")
    if not MCP_FIXTURE.is_file():
        raise RuntimeError(f"missing SDK fixture: {MCP_FIXTURE}")

    work = Path(tempfile.mkdtemp(prefix="lcu-codex-native-approval-"))
    home = work / "home"
    codex_home = home / ".codex"
    project = work / "project"
    log = work / "approval-events.jsonl"
    codex_home.mkdir(parents=True)
    project.mkdir()
    app = f"dev.lcu.NativeFixture.{uuid.uuid4().hex}"
    session_id = f"lcu-native-approval-session-{uuid.uuid4().hex[:12]}"
    turn_id = f"lcu-native-approval-turn-{uuid.uuid4().hex[:12]}"
    failures = []
    call_count = 0

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            nonlocal call_count
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                call_count += 1
                tools = body.get("tools", [])
                has_fixture = any(tool.get("name") == "mcp__fixture" for tool in tools)
                inputs = body.get("input", [])
                latest = inputs[-1].get("type") if inputs else None
                if has_fixture and latest != "function_call_output":
                    item = {
                        "id": f"fixture-call-{call_count}",
                        "type": "function_call",
                        "call_id": f"native-app-{call_count}",
                        "name": "native_app",
                        "namespace": "mcp__fixture",
                        "arguments": "{}",
                    }
                else:
                    item = {
                        "id": f"fixture-message-{call_count}",
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "Fixture complete.", "annotations": []}],
                    }
                response = {
                    "id": f"fixture-response-{call_count}",
                    "object": "response",
                    "model": "fixture",
                    "status": "completed",
                    "output": [item],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                }
                events = [
                    {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                    {"type": "response.output_item.done", "output_index": 0, "item": item},
                    {"type": "response.completed", "response": response},
                ]
                payload = "".join(
                    "event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                    for event in events
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as error:
                failures.append(repr(error))
                self.send_error(500, "Local fixture provider failed")

        def log_message(self, *_args):
            pass

    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    config = codex_home / "config.toml"
    write_config(config, project, node, provider.server_port, log, app, session_id, turn_id)
    # Start with a clean environment so host API keys, Codex accounts, and
    # unrelated MCP configuration cannot participate in the fixture.
    env = {
        "HOME": str(home),
        "CODEX_HOME": str(codex_home),
        "CODEX_CLI_PATH": str(cli),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "TMPDIR": str(work),
        "TERM": "xterm-256color",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
    }
    command = [
        str(cli), "--strict-config", "-a", "on-request",
        "-c", 'model_provider="fixture"', "-c", 'model="fixture"',
        "-C", str(project), "Use the fixture tool once, then finish.",
    ]
    print("Choose Allow, Allow for this session, Always allow, or Cancel in the Codex UI.", flush=True)
    print("After the fixture completes, exit Codex with Ctrl+C. No app action occurs.", flush=True)
    print(f"Isolated work directory: {work}", flush=True)
    process = subprocess.Popen(command, cwd=project, env=env)
    try:
        status = process.wait()
    except KeyboardInterrupt:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
        status = process.wait()
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)

    if failures:
        raise RuntimeError("local fixture provider error: " + "; ".join(failures))
    if not log.exists():
        raise RuntimeError(f"Codex did not reach the MCP elicitation; CLI exit status {status}; work={work}")
    events = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    requests = [event["request"] for event in events if event.get("kind") == "request"]
    responses = [event["response"] for event in events if event.get("kind") == "response"]
    if len(requests) != 1 or len(responses) != 1:
        raise RuntimeError(f"expected one request and response, got {len(requests)} and {len(responses)}; work={work}")
    request = requests[0]
    meta = request.get("_meta", {})
    if (request.get("mode") != "form"
            or request.get("requestedSchema") != {"type": "object", "properties": {}}
            or meta.get("codex_approval_kind") != "mcp_tool_call"
            or meta.get("connector_id") != "computer-use"
            or meta.get("connector_name") != "Computer Use"
            or meta.get("persist") != ["session", "always"]
            or meta.get("tool_name") != "get_app_state"
            or meta.get("tool_params") != {"app": app}
            or meta.get("x-codex-turn-metadata") != {"session_id": session_id, "turn_id": turn_id}):
        raise RuntimeError(f"fixture elicitation differed from the expected original shape; work={work}")
    response = responses[0]
    action = response.get("action")
    scope = response.get("_meta", {}).get("persist", "once")
    if action == "accept" and scope not in ("once", "session", "always"):
        raise RuntimeError(f"unexpected accepted scope {scope!r}; work={work}")
    print(json.dumps({"cli_exit_status": status, "action": action, "scope": scope, "response": response}, sort_keys=True))
    print(f"Sanitized fixture evidence: {log}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path, help="the exact codex executable to probe")
    args = parser.parse_args()
    cli = args.cli.expanduser().resolve()
    if not cli.is_file():
        parser.error(f"Codex CLI does not exist: {cli}")
    return run(cli)


if __name__ == "__main__":
    raise SystemExit(main())
