"""Offline pinned-Codex MCP environment probe; mount original resources at /original."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

def mcp():
    for line in sys.stdin:
        msg = json.loads(line)
        if 'id' not in msg:
            continue
        method = msg['method']
        if method == 'initialize':
            result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'envprobe', 'version': '1'}}
        elif method == 'tools/list':
            result = {'tools': [{'name': 'read', 'description': 'Read isolated test marker environment', 'inputSchema': {'type': 'object', 'properties': {}}}]}
        elif method == 'tools/call':
            keys = ['LCU_PROBE_MARKER', 'LCU_PROBE_CONFIG', 'NODE_REPL_JS_BANNER', 'NODE_REPL_ENABLE_AUDIO', 'SKY_ENABLE_AUDIO', 'NODE_REPL_FORCE_STRICT_AUTO_REVIEW']
            result = {'content': [{'type': 'text', 'text': json.dumps({k: os.environ.get(k) for k in keys})}]}
        else:
            result = {}
        sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result}) + '\n')
        sys.stdout.flush()

def main():
    resources = Path('/original')
    forwarded = '--with-env-vars' in sys.argv
    with tempfile.TemporaryDirectory() as folder:
        work = Path(folder)
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                if len(requests) == 1:
                    item = {'id': 'fc1', 'type': 'function_call', 'call_id': 'observe', 'name': 'read', 'namespace': 'mcp__envprobe', 'arguments': '{}'}
                else:
                    item = {'id': 'message', 'type': 'message', 'status': 'completed', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Done', 'annotations': []}]}
                response = {'id': f'r{len(requests)}', 'object': 'response', 'model': 'fixture', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
                events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}}, {'type': 'response.output_item.done', 'output_index': 0, 'item': item}, {'type': 'response.completed', 'response': response}]
                payload = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *_): pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        home = work / 'home'
        home.mkdir()
        config = f'''[mcp_servers.envprobe]
command = {json.dumps(sys.executable)}
args = {json.dumps([__file__, 'mcp'])}
required = true
{('env_vars = ["LCU_PROBE_MARKER", "NODE_REPL_JS_BANNER", "NODE_REPL_ENABLE_AUDIO"]' if forwarded else '')}
[mcp_servers.envprobe.env]
LCU_PROBE_CONFIG = "present"
[mcp_servers.envprobe.tools.read]
approval_mode = "approve"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
'''
        (home / 'config.toml').write_text(config)
        env = {'HOME': str(work), 'CODEX_HOME': str(home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LCU_PROBE_MARKER': 'inherited', 'NODE_REPL_JS_BANNER': 'inherited', 'NODE_REPL_ENABLE_AUDIO': '1', 'SKY_ENABLE_AUDIO': '0', 'NODE_REPL_FORCE_STRICT_AUTO_REVIEW': '1'}
        command = [str(resources / 'codex'), '--strict-config', '-a', 'never', '-c', 'model_provider="fixture"', '-c', 'model="fixture"', 'exec', '--ephemeral', '--skip-git-repo-check', '--json', '-C', str(work), 'Use envprobe read once.']
        try:
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=45)
        finally:
            server.shutdown(); server.server_close(); thread.join()
        calls = [i for r in requests[1:] for i in r.get('input', []) if i.get('type') == 'function_call_output']
        assert result.returncode == 0 and len(requests) == 2 and len(calls) == 1, (result.stderr, result.stdout)
        value = json.loads(calls[0]['output'][1]['text'])
        assert value['LCU_PROBE_CONFIG'] == 'present', value
        assert value['NODE_REPL_FORCE_STRICT_AUTO_REVIEW'] is None and value['SKY_ENABLE_AUDIO'] is None, value
        assert value['LCU_PROBE_MARKER'] == ('inherited' if forwarded else None), value
        assert value['NODE_REPL_JS_BANNER'] == ('inherited' if forwarded else None), value
        assert value['NODE_REPL_ENABLE_AUDIO'] == ('1' if forwarded else None), value
        print(json.dumps({'env_vars_configured': forwarded, 'child_environment': value}, sort_keys=True))
if __name__ == '__main__':
    mcp() if sys.argv[1:2] == ['mcp'] else main()
