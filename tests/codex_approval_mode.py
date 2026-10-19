"""Show that LCU's Codex approval mode removes the per-call prompt, and only that.

An isolated Codex CLI (own HOME and CODEX_HOME, scripted local model provider, no
account) calls the `js` tool of an MCP server named `lcu` that is the repository's
SDK fixture. The server table is written exactly as `lcu setup` registers it: the
same keys that `--approval ask` and `--approval auto` produce. Under approval
policy `never` the CLI cannot ask, so a tool call that needs approval does not
run. Expected: no tool call without the per-tool `approval_mode`, one with it.

Run it on a host with the Codex CLI under test and `npm ci --prefix adapters`:
    python3 tests/codex_approval_mode.py --cli "$(command -v codex)"
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
from lcu_node import call  # noqa: E402

MCP_FIXTURE = ROOT / 'adapters/test/mcp-fixture.mjs'


def quote(value):
    return json.dumps(str(value), ensure_ascii=False)


def write_config(config, node, port, log, mode):
    lines = [
        'approval_policy = "never"', 'sandbox_mode = "read-only"',
        'model_provider = "fixture"', 'model = "fixture"', '',
        '[mcp_servers.lcu]', f'command = {quote(node)}', f'args = [{quote(MCP_FIXTURE)}]',
        'startup_timeout_sec = 20',
    ]
    # The keys setup registers for this mode.
    with tempfile.TemporaryDirectory() as scratch_dir:
        scratch = str(Path(scratch_dir).resolve())
        policy = call('approval', 'codexPlan', mode, scratch,
                      {'scope': 'user', 'project': scratch, 'env': {'HOME': scratch}})['policy']
    lines += [f'{key} = {quote(value)}' for key, value in policy.items() if key != 'tools']
    for tool, entry in policy.get('tools', {}).items():
        lines += ['', f'[mcp_servers.lcu.tools.{tool}]']
        lines += [f'{key} = {quote(value)}' for key, value in entry.items()]
    lines += ['', '[mcp_servers.lcu.env]', f'LCU_FIXTURE_LOG = {quote(log)}', '',
              '[model_providers.fixture]', 'name = "Local approval fixture"',
              f'base_url = "http://127.0.0.1:{port}/v1"', 'wire_api = "responses"',
              'requires_openai_auth = false', '']
    config.write_text('\n'.join(lines), encoding='utf-8')


def serve():
    calls = {'count': 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls['count'] += 1
            inputs = body.get('input', [])
            has_tool = any(tool.get('name') == 'mcp__lcu' for tool in body.get('tools', []))
            if has_tool and not any(item.get('type') == 'function_call_output' for item in inputs):
                item = {'id': f'call-{calls["count"]}', 'type': 'function_call', 'call_id': f'js-{calls["count"]}',
                        'name': 'js', 'namespace': 'mcp__lcu', 'arguments': json.dumps({'code': 'approval-mode-ok'})}
            else:
                item = {'id': f'message-{calls["count"]}', 'type': 'message', 'status': 'completed',
                        'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Fixture complete.',
                                                          'annotations': []}]}
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


def run_case(cli, node, mode):
    with tempfile.TemporaryDirectory(prefix='lcu-codex-approval-') as temporary:
        work = Path(temporary).resolve()
        home, project, log = work / 'home', work / 'project', work / 'calls.jsonl'
        (home / '.codex').mkdir(parents=True)
        project.mkdir()
        server = serve()
        try:
            write_config(home / '.codex/config.toml', node, server.server_port, log, mode)
            env = {'HOME': str(home), 'CODEX_HOME': str(home / '.codex'), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
                   'TMPDIR': str(work), 'NO_COLOR': '1', 'LC_ALL': 'C.UTF-8'}
            result = subprocess.run([str(cli), 'exec', '--skip-git-repo-check', '-C', str(project),
                                     'Call the lcu js tool once, then finish.'], cwd=project, env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
        finally:
            server.shutdown()
            server.server_close()
        records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        executed = [r for r in records if r.get('name') == 'js' and r.get('args', {}).get('code') == 'approval-mode-ok']
        return {'mode': mode, 'exit_status': result.returncode, 'js_calls_executed': len(executed)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cli', required=True, type=Path, help='the exact codex executable to test')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        parser.error('node must be on PATH')
    if not (ROOT / 'adapters/node_modules/@modelcontextprotocol/sdk').exists():
        parser.error('install the official SDK first: npm ci --prefix adapters --ignore-scripts')
    cli = args.cli.expanduser().resolve()
    version = subprocess.run([str(cli), '--version'], capture_output=True, text=True, timeout=20).stdout.strip()
    ask, auto = run_case(cli, node, 'ask'), run_case(cli, node, 'auto')
    print(json.dumps({'cli': version, 'cases': [ask, auto]}, indent=2))
    if ask['js_calls_executed'] != 0 or auto['js_calls_executed'] != 1:
        print('FAIL: expected the tool to need approval without the setting and run with it', file=sys.stderr)
        return 1
    print('PASS: ask leaves the prompt in force; auto runs the tool without one')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
