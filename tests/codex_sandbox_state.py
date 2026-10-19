"""Observe which `codex/sandbox-state-meta` a Codex CLI sends, directly and through LCU's relay.

An isolated Codex CLI (own HOME and CODEX_HOME, scripted local model provider, no account) calls
`js` on an MCP server that advertises the original node_repl's sandbox-state capability and records
each call's `_meta`. The server is registered directly (as a bare `lcu` registration would be) and
behind `adapters/codex.mjs` (as `lcu setup --agent codex` registers it), under each sandbox mode.

Run it on a host with the Codex CLI under test and `npm ci --prefix adapters`:
    python3 tests/codex_sandbox_state.py --cli "$(command -v codex)"
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'adapters/test/sandbox-meta-fixture.mjs'
RELAY = ROOT / 'adapters/codex.mjs'


def quote(value):
    return json.dumps(str(value), ensure_ascii=False)


def serve():
    calls = {'count': 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls['count'] += 1
            has_tool = any(tool.get('name') == 'mcp__lcu' for tool in body.get('tools', []))
            if has_tool and not any(i.get('type') == 'function_call_output' for i in body.get('input', [])):
                item = {'id': f'call-{calls["count"]}', 'type': 'function_call', 'call_id': f'js-{calls["count"]}',
                        'name': 'js', 'namespace': 'mcp__lcu', 'arguments': json.dumps({'code': 'observe'})}
            else:
                item = {'id': f'message-{calls["count"]}', 'type': 'message', 'status': 'completed',
                        'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Done.', 'annotations': []}]}
            response = {'id': f'response-{calls["count"]}', 'object': 'response', 'model': 'fixture',
                        'status': 'completed', 'output': [item],
                        'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
            events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                      {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                      {'type': 'response.completed', 'response': response}]
            payload = ''.join(f'event: {e["type"]}\ndata: {json.dumps(e)}\n\n' for e in events).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def observe(cli, node, relay, sandbox):
    with tempfile.TemporaryDirectory(prefix='lcu-codex-sandbox-') as temporary:
        work = Path(temporary).resolve()
        home, project, log = work / 'home', work / 'project', work / 'calls.jsonl'
        (home / '.codex').mkdir(parents=True)
        project.mkdir()
        server = serve()
        args = [str(RELAY), node, str(FIXTURE)] if relay else [str(FIXTURE)]
        try:
            (home / '.codex/config.toml').write_text('\n'.join([
                'approval_policy = "never"', f'sandbox_mode = {quote(sandbox)}',
                'model_provider = "fixture"', 'model = "fixture"', '',
                '[mcp_servers.lcu]', f'command = {quote(node)}',
                f'args = [{", ".join(quote(a) for a in args)}]', 'startup_timeout_sec = 20',
                'default_tools_approval_mode = "approve"', '',
                '[mcp_servers.lcu.env]', f'LCU_FIXTURE_LOG = {quote(log)}', '',
                '[model_providers.fixture]', 'name = "Local fixture"',
                f'base_url = "http://127.0.0.1:{server.server_port}/v1"', 'wire_api = "responses"',
                'requires_openai_auth = false', '']), encoding='utf-8')
            env = {'HOME': str(home), 'CODEX_HOME': str(home / '.codex'), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
                   'TMPDIR': str(work), 'NO_COLOR': '1', 'LC_ALL': 'C.UTF-8'}
            subprocess.run([str(cli), 'exec', '--skip-git-repo-check', '-C', str(project),
                            'Call the lcu js tool once, then finish.'], cwd=project, env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
        finally:
            server.shutdown()
            server.server_close()
        records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        calls = [r for r in records if r['name'] == 'js']
        if not calls:
            sent = 'no call reached the server'
        else:
            meta = (calls[0]['meta'] or {}).get('codex/sandbox-state-meta')
            profile = (meta or {}).get('permissionProfile', {})
            sent = 'nothing' if meta is None else {
                'permission_profile': profile.get('type'), 'network': profile.get('network'),
                'file_system': (profile.get('file_system') or {}).get('type')}
        return {'registration': 'relay' if relay else 'direct', 'sandbox_mode': sandbox, 'sent': sent}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cli', required=True, type=Path, help='the exact codex executable to test')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        parser.error('node must be on PATH')
    cli = args.cli.expanduser().resolve()
    version = subprocess.run([str(cli), '--version'], capture_output=True, text=True, timeout=20).stdout.strip()
    cases = [observe(cli, node, relay, sandbox) for relay in (False, True)
             for sandbox in ('read-only', 'workspace-write', 'danger-full-access')]
    print(json.dumps({'cli': version, 'cases': cases}, indent=2))


if __name__ == '__main__':
    main()
