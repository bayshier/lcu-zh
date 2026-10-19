"""Prepare or serve one guarded Claude Code result-delivery case.

The caller must launch the exact `clod` wrapper from a real TTY and type
`START CLAUDE`. The local provider and MCP fixture use synthetic data only.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "adapters/test/result-fixture.mjs"
RELAY = ROOT / "adapters/claude.mjs"
CASES = {"text", "image", "audio", "error"}
FAKE_KEY = "lcu-fixture-only"


def prepare(output: Path, case: str, node: Path, clod: Path, claude_version: Path,
            reported_version: str):
    claude_version = claude_version.resolve(strict=True)
    version_match = re.fullmatch(r"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(Claude Code\)",
                                 reported_version.strip())
    if not version_match or version_match.group(1) != claude_version.name:
        raise ValueError("guarded Claude --version output must match the exact version executable")
    version = version_match.group(1)
    work = output / case
    home = work / "home"
    project = work / "project"
    for directory in (home, project, project / ".claude"):
        directory.mkdir(parents=True, exist_ok=True)

    # Only the two nonsecret onboarding fields are copied into this isolated HOME.
    (home / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True,
        "lastOnboardingVersion": version,
    }, indent=2) + "\n", encoding="utf-8")
    guarded_binary = home / ".local/lib/claude-guard/bin/claude-real"
    guarded_binary.parent.mkdir(parents=True, exist_ok=True)
    if not guarded_binary.exists():
        guarded_binary.write_text(
            '#!/bin/sh\n'
            f'exec "$HOME/.local/share/claude/versions/{version}" "$@"\n',
            encoding="utf-8")
        guarded_binary.chmod(0o700)
    version_binary = home / ".local/share/claude/versions" / claude_version.name
    version_binary.parent.mkdir(parents=True, exist_ok=True)
    if not version_binary.exists():
        version_binary.symlink_to(claude_version)

    result_log = work / "mcp-result.jsonl"
    (work / "host-version.json").write_text(json.dumps({
        "output": reported_version.strip(), "version": version,
    }, indent=2) + "\n", encoding="utf-8")
    mcp = {"mcpServers": {"lcu": {
        "type": "stdio",
        "command": str(node),
        "args": [str(RELAY), str(node), str(FIXTURE)],
        "env": {"LCU_RESULT_LOG": str(result_log)},
    }}}
    (project / ".mcp.json").write_text(json.dumps(mcp, indent=2) + "\n", encoding="utf-8")
    sys.path.insert(0, str(ROOT / "tests"))
    from lcu_node import call
    call("claude_visibility", "install", home, {"project": project})
    return {"home": str(home), "project": str(project), "claude_version": version,
            "claude_version_output": reported_version.strip(),
            "result_log": str(result_log), "fake_key": FAKE_KEY,
            "mcp_config": str(project / ".mcp.json"),
            "settings": str(project / ".claude/settings.local.json")}


def sse(response):
    events = [("message_start", {"type": "message_start", "message": {
        **response, "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 1}}})]
    for index, block in enumerate(response["content"]):
        initial = {key: value for key, value in block.items() if key in ("type", "id", "name")}
        if block["type"] == "tool_use":
            initial["input"] = {}
        else:
            initial["text"] = ""
        events.append(("content_block_start", {"type": "content_block_start", "index": index, "content_block": initial}))
        if block["type"] == "tool_use":
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"], separators=(",", ":"))}
        else:
            delta = {"type": "text_delta", "text": block["text"]}
        events.append(("content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta}))
        events.append(("content_block_stop", {"type": "content_block_stop", "index": index}))
    events.extend([
        ("message_delta", {"type": "message_delta", "delta": {
            "stop_reason": response["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": 8}}),
        ("message_stop", {"type": "message_stop"}),
    ])
    return "".join("event: " + name + "\ndata: " + json.dumps(value, separators=(",", ":")) + "\n\n"
                   for name, value in events).encode()


def serve(case: str, output: Path, port: int):
    work = output / case
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    work.chmod(0o700)
    requests_path = work / "provider-requests.json"
    summary_path = work / "provider-summary.json"
    requests, attempts, failures = [], [], []
    state = {"title": False, "tool_call": False, "tool_result": False}
    state_lock = threading.Lock()
    tool_id = f"result-{case}"

    def title_request(body):
        output_config = body.get("output_config", {})
        format_config = output_config.get("format", {}) if isinstance(output_config, dict) else {}
        schema = format_config.get("schema", {}) if isinstance(format_config, dict) else {}
        properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
        return (format_config.get("type") == "json_schema" and isinstance(properties, dict) and
                set(properties) == {"title"} and schema.get("required") == ["title"])

    def tool_results(body):
        return [block for message in body.get("messages", []) if isinstance(message, dict)
                for block in (message.get("content", []) if isinstance(message.get("content"), list) else [])
                if isinstance(block, dict) and block.get("type") == "tool_result"]

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                if self.path.split("?", 1)[0].rstrip("/") != "/v1/messages":
                    self.send_error(404)
                    return
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
                with state_lock:
                    requests.append(body)
                    request_index = len(requests)
                    requests_path.write_text(json.dumps(requests, indent=2), encoding="utf-8")
                    requests_path.chmod(0o600)
                if self.headers.get("x-api-key") != FAKE_KEY:
                    raise AssertionError("Claude request omitted the synthetic fixture API key")
                tool_names = [tool.get("name") for tool in body.get("tools", []) if isinstance(tool, dict)]
                results = tool_results(body)
                if title_request(body):
                    if tool_names or results:
                        raise AssertionError("Claude title metadata request unexpectedly carried tools or results")
                    phase = "title_metadata"
                    response = {"id": f"fixture-{case}-title", "type": "message", "role": "assistant",
                                "model": body.get("model", "fixture"),
                                "content": [{"type": "text", "text": json.dumps({
                                    "title": f"LCU result fixture {case}"})}],
                                "stop_reason": "end_turn", "stop_sequence": None,
                                "usage": {"input_tokens": 1, "output_tokens": 5}}
                    state_key = "title"
                elif results:
                    if len(results) != 1 or results[0].get("tool_use_id") != tool_id:
                        raise AssertionError(f"Claude sent unexpected tool result IDs: {[item.get('tool_use_id') for item in results]}")
                    if not state["tool_call"]:
                        raise AssertionError("Claude returned a result before the scripted js call")
                    phase = "tool_result"
                    response = {"id": f"fixture-{case}-done", "type": "message", "role": "assistant",
                                "model": body.get("model", "fixture"),
                                "content": [{"type": "text", "text": f"Fixture {case} complete."}],
                                "stop_reason": "end_turn", "stop_sequence": None,
                                "usage": {"input_tokens": 1, "output_tokens": 8}}
                    state_key = "tool_result"
                elif "mcp__lcu__js" in tool_names:
                    phase = "tool_call"
                    response = {"id": f"fixture-{case}-call", "type": "message", "role": "assistant",
                                "model": body.get("model", "fixture"),
                                "content": [{"type": "tool_use", "id": tool_id, "name": "mcp__lcu__js",
                                             "input": {"code": f"lcu-result:{case}"}}],
                                "stop_reason": "tool_use", "stop_sequence": None,
                                "usage": {"input_tokens": 1, "output_tokens": 8}}
                    state_key = "tool_call"
                else:
                    raise AssertionError("Claude provider request was neither title metadata, a js call, nor a result")
                with state_lock:
                    if state[state_key]:
                        raise AssertionError(f"Claude repeated the {phase} request")
                    state[state_key] = True
                event_body = sse(response) if body.get("stream") else None
                if event_body is not None:
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.send_header("cache-control", "no-cache")
                    self.send_header("content-length", str(len(event_body)))
                    self.end_headers()
                    self.wfile.write(event_body)
                    self.wfile.flush()
                else:
                    self.send_json(200, response)
                attempt = {"request": request_index, "phase": phase, "model": body.get("model"),
                           "tool_count": len(tool_names), "js_advertised": "mcp__lcu__js" in tool_names,
                           "tool_result_count": len(results), "response_status": 200,
                           "stop_reason": response.get("stop_reason")}
                if results:
                    attempt["tool_result_is_error"] = bool(results[0].get("is_error", False))
                    attempt["tool_result_content_types"] = [block.get("type") for block in results[0].get("content", [])
                                                               if isinstance(block, dict)]
                with state_lock:
                    attempts.append(attempt)
                    complete = state["tool_call"] and state["tool_result"]
                if complete:
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
            except Exception as error:
                with state_lock:
                    failures.append(repr(error))
                self.send_json(500, {"error": {"type": "internal_error", "message": "local fixture failed"}})

        def send_json(self, status, body):
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"fixture provider listening on 127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    if failures:
        raise RuntimeError("; ".join(failures))
    expected = {"tool_call": True, "tool_result": True}
    if any(state[key] is not value for key, value in expected.items()):
        raise RuntimeError(f"expected one js call/result round trip, state={state}")
    attempts.sort(key=lambda item: item["request"])
    phases = [item["phase"] for item in attempts]
    if (phases.count("tool_call") != 1 or phases.count("tool_result") != 1 or
            phases.count("title_metadata") > 1):
        raise RuntimeError(f"unexpected provider phases: {attempts}")
    summary_path.write_text(json.dumps({"case": case, "request_count": len(requests), "attempts": attempts}, indent=2),
                            encoding="utf-8")
    summary_path.chmod(0o600)


def verify(case: str, output: Path):
    work = output / case
    records = [json.loads(line) for line in (work / "mcp-result.jsonl").read_text(encoding="utf-8").splitlines()]
    original_calls = [row for row in records if row.get("kind") == "call" and row.get("name") == "js"]
    original_results = [row["result"] for row in records if row.get("kind") == "result"]
    payload = next((row for row in records if row.get("kind") == "payload"), None)
    if len(original_calls) != 1 or original_calls[0].get("args", {}).get("code") != f"lcu-result:{case}":
        raise AssertionError(f"expected exactly one original js call for {case}")
    if len(original_results) != 1:
        raise AssertionError(f"expected exactly one original result for {case}")
    call_meta = original_calls[0].get("meta", {})
    turn_meta = call_meta.get("x-codex-turn-metadata", {})
    if not isinstance(call_meta.get("claudecode/toolUseId"), str) or not all(
            isinstance(turn_meta.get(key), str) for key in ("session_id", "turn_id")):
        raise AssertionError("Claude did not forward its exact tool-use and turn identity")

    original = original_results[0]
    requests = json.loads((work / "provider-requests.json").read_text(encoding="utf-8"))
    summary = json.loads((work / "provider-summary.json").read_text(encoding="utf-8"))
    phases = [attempt["phase"] for attempt in summary.get("attempts", [])]
    if (summary.get("request_count") not in (2, 3) or
            phases.count("tool_call") != 1 or phases.count("tool_result") != 1 or
            phases.count("title_metadata") > 1):
        raise AssertionError(f"unexpected Claude provider request phases: {summary}")
    if any(attempt.get("response_status") != 200 for attempt in summary["attempts"]):
        raise AssertionError("the scripted Claude provider returned a non-success response")

    title_requests = [body for body in requests if title_request_from_body(body)]
    tool_call_requests = [body for body in requests if any(
        isinstance(tool, dict) and tool.get("name") == "mcp__lcu__js" for tool in body.get("tools", []))]
    tool_result_blocks = [block for body in requests for message in body.get("messages", [])
                          if isinstance(message, dict)
                          for block in (message.get("content", []) if isinstance(message.get("content"), list) else [])
                          if isinstance(block, dict) and block.get("type") == "tool_result"]
    if len(title_requests) > 1 or len(tool_call_requests) != 2 or len(tool_result_blocks) != 1:
        raise AssertionError("expected at most one optional title request, tool-enabled call/result requests, and one result block")
    tool_result = tool_result_blocks[0]
    if tool_result.get("tool_use_id") != f"result-{case}":
        raise AssertionError("provider result was correlated to the wrong Claude tool-use ID")

    host_version = json.loads((work / "host-version.json").read_text(encoding="utf-8"))
    provider_summary = {"host": "Claude Code", "version": host_version["version"],
                        "version_output": host_version["output"], "case": case,
                        "provider_requests": summary["request_count"], "original_types": [
                            block.get("type") for block in original.get("content", [])],
                        "provider_result_types": ([block.get("type") for block in tool_result.get("content", [])]
                                                  if isinstance(tool_result.get("content"), list) else ["text"]),
                        "original_isError": bool(original.get("isError", False)),
                        "provider_is_error": bool(tool_result.get("is_error", False))}

    if case == "text":
        expected = original["content"][0]["text"]
        content = tool_result.get("content")
        texts = [block.get("text", "") for block in content if isinstance(block, dict)] if isinstance(content, list) else [str(content)]
        if not any(expected in text for text in texts) or tool_result.get("is_error", False):
            raise AssertionError("Claude did not preserve the original text result")
    elif case == "image":
        expected = original["content"][0]
        if not payload or expected.get("type") != "image":
            raise AssertionError("image fixture did not produce an original image result")
        images = [block for block in tool_result.get("content", []) if isinstance(block, dict) and block.get("type") == "image"]
        if len(images) != 1:
            raise AssertionError("Claude did not forward exactly one image block to the provider")
        source = images[0].get("source", {})
        expected_bytes = base64.b64decode(expected["data"])
        provider_bytes = base64.b64decode(source.get("data", ""))
        if source.get("type") != "base64" or source.get("media_type") != expected["mimeType"] or provider_bytes != expected_bytes:
            raise AssertionError("Claude changed the original image bytes or media type")
        provider_summary["original_sha256"] = payload["sha256"]
        provider_summary["provider_sha256"] = hashlib.sha256(provider_bytes).hexdigest()
    elif case == "audio":
        expected = original["content"][0]
        if not payload or expected.get("type") != "audio" or tool_result.get("is_error", False):
            raise AssertionError("Claude did not deliver the original audio result as a non-error")
        content = tool_result.get("content")
        texts = [block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text"]
        audio_references = [text for text in texts if "[Audio from lcu]" in text]
        if len(audio_references) != 1 or expected["data"] in json.dumps(tool_result):
            raise AssertionError("Claude provider request should contain an audio file reference, not WAV bytes")
        match = re.search(r"saved to (.+)$", audio_references[0])
        if not match:
            raise AssertionError("Claude did not provide a saved audio result path")
        audio_path = Path(match.group(1)).resolve(strict=True)
        if not audio_path.is_relative_to(work.resolve()):
            raise AssertionError("Claude saved the audio fixture outside the isolated HOME")
        audio_bytes = audio_path.read_bytes()
        expected_bytes = base64.b64decode(expected["data"])
        if audio_bytes != expected_bytes:
            raise AssertionError("Claude's isolated audio result file changed the original WAV bytes")
        provider_summary["original_sha256"] = payload["sha256"]
        provider_summary["saved_audio_sha256"] = hashlib.sha256(audio_bytes).hexdigest()
        provider_summary["provider_received_audio_bytes"] = False
    else:
        expected = original["content"][0]["text"]
        content = tool_result.get("content")
        text = content if isinstance(content, str) else "".join(
            block.get("text", "") for block in content if isinstance(block, dict))
        if not original.get("isError") or not tool_result.get("is_error") or expected not in text:
            raise AssertionError("Claude did not preserve the original error flag and text")

    print(json.dumps(provider_summary, sort_keys=True))


def title_request_from_body(body):
    output_config = body.get("output_config", {})
    format_config = output_config.get("format", {}) if isinstance(output_config, dict) else {}
    schema = format_config.get("schema", {}) if isinstance(format_config, dict) else {}
    properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
    return (format_config.get("type") == "json_schema" and isinstance(properties, dict) and
            set(properties) == {"title"} and schema.get("required") == ["title"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--case", choices=sorted(CASES), required=True)
    prep.add_argument("--output", type=Path, required=True)
    prep.add_argument("--node", type=Path, required=True)
    prep.add_argument("--clod", type=Path, required=True)
    prep.add_argument("--claude-version", type=Path, required=True,
                      help="exact installed Claude Code version executable referenced by the guard shim")
    prep.add_argument("--reported-version", required=True,
                      help="exact output from the guarded clod --version invocation")
    provider = sub.add_parser("serve")
    provider.add_argument("--case", choices=sorted(CASES), required=True)
    provider.add_argument("--output", type=Path, required=True)
    provider.add_argument("--port", type=int, default=18769)
    check = sub.add_parser("verify")
    check.add_argument("--case", choices=sorted(CASES), required=True)
    check.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "prepare":
        print(json.dumps(prepare(args.output, args.case, args.node.resolve(), args.clod.resolve(),
                                 args.claude_version, args.reported_version), sort_keys=True))
    elif args.mode == "serve":
        serve(args.case, args.output, args.port)
    else:
        verify(args.case, args.output)


if __name__ == "__main__":
    main()
