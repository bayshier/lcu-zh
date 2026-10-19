"""Opt-in end-to-end test of the generated OMP extension through its real host."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
from lcu_node import call as lcu_call  # noqa: E402
OMP = os.environ.get("OMP_BIN")
TEMP_PARENT = "/private/tmp" if sys.platform == "darwin" else "/tmp" if os.name == "posix" else None


class _FixtureProvider(BaseHTTPRequestHandler):
    requests: list[dict] = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        self.requests.append(request)
        common = {"id": "lcu-omp-fixture", "object": "chat.completion.chunk",
                  "created": 1, "model": "lcu-fixture"}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def send(value):
            self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
            self.wfile.flush()

        if len(self.requests) == 1:
            call = {"index": 0, "id": "fixture-call", "type": "function",
                    "function": {"name": "js", "arguments": json.dumps({"code": "omp-live-host-tool"})}}
            send({**common, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]},
                                          "finish_reason": None}]})
            send({**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
        else:
            send({**common, "choices": [{"index": 0, "delta": {"role": "assistant",
                                                                     "content": "OMP fixture turn complete."},
                                          "finish_reason": None}]})
            send({**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


@unittest.skipUnless(OMP, "Set OMP_BIN to an installed OMP executable for native host verification.")
class OmpHostTests(unittest.TestCase):
    def test_generated_extension_delivers_first_prompt_calls_original_tool_and_cleans_up(self):
        _FixtureProvider.requests = []
        with tempfile.TemporaryDirectory(prefix="lcu-omp-host-", dir=TEMP_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            profile = home / ".omp/profiles/lcu-fixture/agent"
            profile.mkdir(parents=True)
            for name in ("config", "data", "cache", "cwd", "session"):
                (root / name).mkdir()

            provider = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureProvider)
            thread = threading.Thread(target=provider.serve_forever, daemon=True)
            thread.start()
            def stop_provider():
                provider.shutdown()
                provider.server_close()
                thread.join(5)

            self.addCleanup(stop_provider)

            (profile / "models.yml").write_text(
                "providers:\n  openai:\n    api: openai-completions\n"
                f"    baseUrl: http://127.0.0.1:{provider.server_address[1]}/v1\n"
                "    apiKey: fixture-invalid\n    models:\n      - id: lcu-fixture\n"
                "        contextWindow: 8192\n        maxTokens: 1024\n        supportsTools: true\n",
                encoding="utf-8",
            )

            node = Path(shutil.which("node") or "").resolve()
            self.assertTrue(node.is_file(), "Node is required for the original LCU MCP fixture")
            fixture = ROOT / "adapters/test/mcp-fixture.mjs"
            fixture_log = root / "mcp.jsonl"
            env = {
                "PATH": os.pathsep.join([str(Path(OMP).resolve().parent), str(node.parent), "/usr/bin", "/bin"]),
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(root / "config"),
                "XDG_DATA_HOME": str(root / "data"),
                "XDG_CACHE_HOME": str(root / "cache"),
                "OMP_PROFILE": "lcu-fixture",
                "PI_CODING_AGENT_DIR": str(profile),
                "OPENAI_API_KEY": "fixture-invalid",
                "NO_COLOR": "1",
                "NO_PROXY": "localhost,127.0.0.1",
                "no_proxy": "localhost,127.0.0.1",
                "LCU_MCP_COMMAND": json.dumps([str(node), str(fixture)]),
                "LCU_FIXTURE_LOG": str(fixture_log),
            }
            lcu_call("harness_setup", "configureOmp", home, [str(node), str(fixture)], ROOT,
                 {"scope": "user", "env": env})

            command = [str(Path(OMP).resolve()), "--print", "--no-session",
                       "--cwd", str(root / "cwd"), "--session-dir", str(root / "session"),
                       "--model", "openai/lcu-fixture", "--api-key", "fixture-invalid",
                       "Call the js tool once with code omp-live-host-tool, then finish."]
            result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=90)
            self.assertEqual(result.returncode, 0, result.stderr + "\n" + result.stdout)
            self.assertEqual(len(_FixtureProvider.requests), 2, result.stderr)
            first = _FixtureProvider.requests[0]
            tool_names = {tool.get("function", {}).get("name") for tool in first.get("tools", [])}
            logs = home / ".omp/profiles/lcu-fixture/logs"
            host_logs = "\n".join(path.read_text(encoding="utf-8", errors="replace")
                                   for path in logs.glob("*.log")) if logs.exists() else "<none>"
            self.assertIn("js", tool_names,
                          "the original JS tool must reach the first model request; "
                          f"OMP stderr={result.stderr!r}; MCP log="
                          f"{fixture_log.read_text(encoding='utf-8') if fixture_log.exists() else '<none>'}; "
                          f"OMP logs={host_logs}")
            first_prompt = json.dumps(first.get("messages", []), ensure_ascii=False)
            self.assertIn("Original CUA initialization guide", first_prompt)

            entries = [json.loads(line) for line in fixture_log.read_text(encoding="utf-8").splitlines()]
            call = next(entry for entry in entries if entry.get("name") == "js")
            metadata = call["meta"]["x-codex-turn-metadata"]
            self.assertEqual(call["args"]["code"], "omp-live-host-tool")
            self.assertTrue(metadata["session_id"])
            self.assertTrue(metadata["model"])
            self.assertEqual(metadata["call_id"], "fixture-call")
            cleanup = next(entry for entry in entries if entry.get("name") == "turn_ended")
            self.assertEqual(cleanup["args"]["hook_event_name"], "Stop")
            self.assertEqual(cleanup["args"]["session_id"], metadata["session_id"])
            self.assertEqual(cleanup["args"]["turn_id"], metadata["turn_id"])


if __name__ == "__main__":
    unittest.main()
