"""Exercise the installed OMP TUI's actual LCU approval selectors in a PTY.

Only a generated MCP fixture and local scripted provider are used. No desktop,
real provider credential, or personal OMP profile is accessed.
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
CASES = [
    ('native-once', 'approval-native', 'Allow once', 0, {'action': 'accept', 'content': {}}),
    ('native-session', 'approval-native', 'Allow for this session', 1,
     {'action': 'accept', 'content': {}, '_meta': {'persist': 'session'}}),
    ('native-always', 'approval-native', 'Always allow', 2,
     {'action': 'accept', 'content': {}, '_meta': {'persist': 'always'}}),
    ('native-decline', 'approval-native', 'Decline', 3, {'action': 'decline'}),
    ('native-dismiss', 'approval-native', 'Allow once', None, {'action': 'cancel'}),
    ('session-only', 'approval-native-session-only', 'Allow for this session', 1,
     {'action': 'accept', 'content': {}, '_meta': {'persist': 'session'}}),
    ('origin-accept', 'pi-origin-approval', 'Allow', 0, {'action': 'accept', 'content': {}}),
    ('origin-decline', 'pi-origin-approval', 'Decline', 1, {'action': 'decline'}),
    ('origin-dismiss', 'pi-origin-approval', 'Allow', None, {'action': 'cancel'}),
]


def exercise(omp: Path, case, evidence: Path):
    name, code, label, selection, expected = case
    requests = []
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            common = {'id': 'lcu-ui', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture'}
            if len(requests) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{
                    'index': 0, 'id': 'approval-call', 'type': 'function',
                    'function': {'name': 'js', 'arguments': json.dumps({'code': code})},
                }]}
                finish = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': 'Approval UI fixture complete.'}
                finish = 'stop'
            for value in [
                {**common, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                {**common, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}]},
            ]:
                self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    captured = bytearray()
    answered = False
    result = None
    with tempfile.TemporaryDirectory(prefix='lcu-omp-ui-', dir='/private/tmp' if sys.platform == 'darwin' else None) as temp:
        root = Path(temp)
        home = root / 'home'
        profile = home / '.omp/profiles/lcu-ui/agent'
        profile.mkdir(parents=True)
        for folder in ('config', 'data', 'cache', 'cwd'):
            (root / folder).mkdir()
        (profile / 'models.yml').write_text(
            'providers:\n  openai:\n    api: openai-completions\n'
            f'    baseUrl: http://127.0.0.1:{server.server_port}/v1\n'
            '    apiKey: fixture-invalid\n    models:\n      - id: fixture\n'
            '        contextWindow: 200000\n        maxTokens: 1024\n        supportsTools: true\n')
        node = Path(shutil.which('node') or '').resolve()
        if not node.is_file():
            raise RuntimeError('Node is required for the MCP fixture')
        log = root / 'mcp.jsonl'
        env = {
            'PATH': os.pathsep.join([str(omp.parent), str(node.parent), '/usr/bin', '/bin']),
            'HOME': str(home), 'TMPDIR': str(root),
            'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'),
            'XDG_CACHE_HOME': str(root / 'cache'), 'OMP_PROFILE': 'lcu-ui',
            'PI_CODING_AGENT_DIR': str(profile), 'LCU_FIXTURE_LOG': str(log),
            'OPENAI_API_KEY': 'fixture-invalid', 'TERM': 'xterm-256color', 'NO_COLOR': '1',
        }
        call('harness_setup', 'configureOmp', home, [str(node), str(ROOT / 'adapters/test/mcp-fixture.mjs')],
             ROOT, {'scope': 'user', 'env': env})
        # Official OMP v18.4.1 setup-version.ts declares CURRENT_SETUP_VERSION=2.
        # This generated profile already has its model/provider configured.
        with (profile / 'config.yml').open('a') as config:
            config.write('\nsetupVersion: 2\nstartup:\n  quiet: true\n')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 150, 0, 0))
        process = subprocess.Popen([
            str(omp), '--no-session', '--no-title', '--tools=js,js_reset',
            '--model', 'openai/fixture', '--api-key', 'fixture-invalid', '--thinking=off',
            '--cwd', str(root / 'cwd'), 'Run the generated approval fixture once.',
        ], stdin=slave, stdout=slave, stderr=slave, cwd=root / 'cwd', env=env, start_new_session=True)
        os.close(slave)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if select.select([master], [], [], .05)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    captured.extend(data)
                    if b'\x1b[6n' in data:
                        os.write(master, b'\x1b[1;1R')
                rendered = ANSI.sub('', captured.decode('utf-8', 'replace'))
                title = 'Allow Computer Use to use' if code.startswith('approval-native') else 'Allow Browser use to access'
                if not answered and title in rendered and label in rendered:
                    if name == 'session-only' and 'Always allow' in rendered:
                        raise AssertionError('UI offered permanent approval when the original request omitted it')
                    os.write(master, b'\x1b' if selection is None else b'\x1b[B' * selection + b'\r')
                    answered = True
                if len(requests) >= 2:
                    responses = [m for m in requests[1].get('messages', []) if m.get('role') == 'tool']
                    if responses:
                        result = responses[-1].get('content')
                        break
            if isinstance(result, list):
                result = '\n'.join(item.get('text', '') for item in result if isinstance(item, dict))
            actual = json.loads(result) if isinstance(result, str) else result
            assert answered, 'OMP did not render the expected real approval selector'
            assert actual == expected, f'{name}: expected {expected}, got {actual}'
            # Wait for the host's actual agent_end hook, not merely the provider request.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                entries = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
                if any(entry.get('name') == 'turn_ended' for entry in entries):
                    break
                if select.select([master], [], [], .05)[0]:
                    captured.extend(os.read(master, 65536))
            assert any(entry.get('name') == 'turn_ended' for entry in entries), 'No normal turn cleanup'
            return {'case': name, 'response': actual, 'selector_observed': True, 'cleanup_observed': True}
        finally:
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / (name + '.terminal.txt')).write_text(ANSI.sub('', captured.decode('utf-8', 'replace')))
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--omp', default=os.environ.get('OMP_BIN'), required=not bool(os.environ.get('OMP_BIN')))
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--case', choices=[case[0] for case in CASES])
    args = parser.parse_args()
    omp = Path(args.omp).resolve()
    reports = []
    for case in CASES:
        if args.case and case[0] != args.case:
            continue
        reports.append(exercise(omp, case, args.evidence))
        print(json.dumps(reports[-1]), flush=True)
    args.evidence.joinpath('summary.json').write_text(json.dumps(reports, indent=2) + '\n')


if __name__ == '__main__':
    main()
