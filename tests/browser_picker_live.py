"""Drive Pi's real TUI picker against the disposable Chrome provider fixture."""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import threading
import termios
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def main():
    release = os.environ["LCU_BROWSER_RELEASE"]
    pi = os.environ["LCU_PI_CLI"]
    provider_requests = []

    class ProviderHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            provider_requests.append(self.path)
            self.send_response(500)
            self.end_headers()

        def log_message(self, *_args):
            pass

    provider = HTTPServer(("127.0.0.1", 0), ProviderHandler)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    observer = Path("/tmp/lcu-picker-observer.mjs")
    evidence = Path("/tmp/lcu-picker-draft.json")
    ready = Path("/tmp/lcu-picker-ready")
    evidence.unlink(missing_ok=True)
    ready.unlink(missing_ok=True)
    observer.write_text(f'''import {{ writeFileSync }} from "node:fs";
export default function(pi) {{
  let timer;
  pi.on("session_start", (_event, ctx) => {{
    writeFileSync({json.dumps(str(ready))}, "ready");
    timer = setInterval(() => {{
      if (ctx.hasUI) writeFileSync({json.dumps(str(evidence))}, JSON.stringify(ctx.ui.getEditorText()));
    }}, 50);
  }});
  pi.on("session_shutdown", () => {{
    if (timer) clearInterval(timer);
  }});
}}
''')
    env = os.environ.copy()
    env["LCU_MCP_COMMAND"] = json.dumps([f"{release}/bin/lcu", "--chrome"])
    env["PI_CODING_AGENT_DIR"] = "/tmp/pi-picker-home"
    env["PI_OFFLINE"] = "1"
    pi_home = Path(env["PI_CODING_AGENT_DIR"])
    pi_home.mkdir(exist_ok=True)
    (pi_home / "models.json").write_text(json.dumps({"providers": {"fixture": {
        "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1", "api": "openai-completions",
        "apiKey": "disposable-no-use", "models": [{
            "id": "picker-smoke", "name": "Picker smoke fixture", "reasoning": False,
            "input": ["text", "image"], "cost": {"input": 0, "output": 0,
            "cacheRead": 0, "cacheWrite": 0}, "contextWindow": 4096, "maxTokens": 128,
        }],
    }}}))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    proc = subprocess.Popen([
        "node", pi, "--offline", "--no-session", "--no-tools", "--no-extensions",
        "--extension", "/src/adapters/pi/index.ts", "--extension", str(observer),
    ], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)
    output = bytearray()

    def until(needle, timeout=45):
        deadline = time.monotonic() + timeout
        while needle.encode() not in output:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"Pi TUI did not show {needle!r}; tail={output[-6000:]!r}")
            ready, _, _ = select.select([master], [], [], min(remaining, 1))
            if ready:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    raise AssertionError(f"Pi exited before {needle!r}; tail={output[-6000:]!r}")

    def key(value):
        os.write(master, value.encode())
        time.sleep(.25)
        while select.select([master], [], [], .05)[0]:
            output.extend(os.read(master, 65536))

    try:
        deadline = time.monotonic() + 45
        while not ready.exists() and time.monotonic() < deadline:
            ready_to_read, _, _ = select.select([master], [], [], .25)
            if ready_to_read:
                output.extend(os.read(master, 65536))
        assert ready.exists(), f"Pi session did not become ready; tail={output[-2000:]!r}"
        key("/lcu pick\r")
        until("Pick a Computer Use target")
        # Browser targets are the second choice after native apps.
        key("\x1b[B\r")
        until("Pick a browser or profile")
        # The disposable fixture starts one isolated Chrome profile.
        key("\r")
        until("Pick tab type in")
        # Select a tab already open in the disposable user's Chrome profile.
        key("\x1b[B\r")
        until("Pick a tab in")
        key("\r")
        until("Review and submit")
        deadline = time.monotonic() + 10
        draft = ""
        while time.monotonic() < deadline:
            if evidence.exists():
                draft = json.loads(evidence.read_text())
                if "provider tab ID" in draft:
                    break
            time.sleep(.1)
        assert "open user tab" in draft, draft
        assert "provider tab ID" in draft and "about:blank" in draft, draft
        assert "browser ID" in draft and "Chrome" in draft, draft
        assert provider_requests == [], provider_requests
        result = {"picker": "PASS", "draft": draft,
                  "submitted": False, "providerRequests": provider_requests,
                  "piVersion": "0.87.1"}
        if result_path := os.environ.get("LCU_PICKER_RESULT_PATH"):
            Path(result_path).write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, sort_keys=True))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        os.close(master)
        provider.shutdown()
        provider.server_close()


if __name__ == "__main__":
    main()
