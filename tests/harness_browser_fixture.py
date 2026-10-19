"""Serve a generated local browser page and save its result as a file oracle."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import os
import re


OUTPUT = Path(os.environ.get("LCU_BROWSER_OUTPUT_DIR", "/tmp/lcu-browser-output"))
OUTPUT.mkdir(parents=True, exist_ok=True)
for name in ("Target.txt", "Other.txt"):
    (OUTPUT / name).unlink(missing_ok=True)

PAGE = b'''<!doctype html><meta charset="utf-8"><title>LCU Browser Target</title>
<h1>LCU Browser Target</h1><label for="draft">Draft text</label>
<input id="draft" autocomplete="off"><button id="save" onclick="fetch('/save?value='+encodeURIComponent(document.querySelector('#draft').value)).then(r=>r.text()).then(t=>document.querySelector('#status').textContent=t)">Save draft</button>
<output id="status">Not saved</output>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/":
            body = PAGE
            status = 200
            content_type = "text/html; charset=utf-8"
        elif parsed.path == "/save":
            value = parse_qs(parsed.query, keep_blank_values=True).get("value", [""])[0]
            if not re.fullmatch(r"omp-browser-[a-f0-9]{12}|hermes-browser-[a-f0-9]{12}", value):
                body, status = b"invalid marker", 400
            else:
                (OUTPUT / "Target.txt").write_text(value, encoding="utf-8")
                body, status = ("Saved: " + value).encode(), 200
            content_type = "text/plain; charset=utf-8"
        else:
            body, status, content_type = b"not found", 404, "text/plain"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
