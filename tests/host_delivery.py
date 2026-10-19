"""Exercise actual Codex model-input delivery against a local scripted model.

Run in an offline disposable Linux desktop with the pinned upstream resources
and installed LCU. No credentials or external model are used. The fixture grants
approval only for its own read-only MCP calls in its private Codex configuration.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


def run(resources, release, output, side, budget, *, action_window=None, deny=False):
    label = ('approval-denied' if deny else 'approval-allowed') if action_window is not None else str(budget)
    work = output / f'{side}-{label}'
    work.mkdir(parents=True)
    home = work / 'codex-home'
    home.mkdir()
    runtime = resources / 'cua_node' if side == 'upstream' else release / 'app/resources/cua_node'
    command = [str(runtime / 'bin/node'), str(runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')] if side == 'upstream' else [str(release / 'bin/lcu')]
    cli = resources / 'codex' if side == 'upstream' else release / 'app/resources/codex'
    requests, errors = [], []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                (work / 'model-inputs.json').write_text(json.dumps(requests, indent=2))
                if len(requests) == 1:
                    namespace = next(t for t in body['tools'] if t.get('name') == 'mcp__lcu')
                    assert {t['name'] for t in namespace['tools']} == {'js', 'js_reset'}, namespace
                    code = 'await cua.getState();' if action_window is None else (
                        'var target=await cua.getApp({windowId:(await cua.listWindows({emit:false})).find(w=>w.title==="LCU Fallback").id}); '
                        'await target.click([40,40]); await target.getAXState();')
                    item = {'id': 'fc1', 'type': 'function_call', 'call_id': 'observe',
                            'name': 'js', 'namespace': 'mcp__lcu',
                            'arguments': json.dumps({'code': code, 'title': 'Exercise isolated approval fixture' if action_window is not None else 'Observe isolated fixture'})}
                else:
                    item = {'id': 'message', 'type': 'message', 'status': 'completed', 'role': 'assistant',
                            'content': [{'type': 'output_text', 'text': 'Fixture complete.', 'annotations': []}]}
                response = {'id': f'r{len(requests)}', 'object': 'response', 'model': 'fixture',
                            'status': 'completed', 'output': [item],
                            'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
                events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                          {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                          {'type': 'response.completed', 'response': response}]
                payload = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as exc:
                errors.append(repr(exc))
                self.send_error(500, 'Fixture assertion failed')

        def log_message(self, *_args):
            pass

    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {
        'CUA_REPL_NODE_REPL_PATH': str(runtime / 'bin/node_repl'),
        'CUA_REPL_ENABLED_SURFACES': 'computer',
        'NODE_REPL_NODE_PATH': str(runtime / 'bin/node'),
        'NODE_REPL_NODE_MODULE_DIRS': str(runtime / 'lib/node_modules'),
        'NODE_REPL_TRUSTED_CODE_PATHS': str(runtime / 'lib/node_modules'),
        'NODE_REPL_DISABLE_ANALYTICS': '1',
        'CODEX_CLI_PATH': str(cli),
        'BROWSER_USE_AVAILABLE_BACKENDS': 'chrome,cdp',
        **{key: os.environ[key] for key in ('DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR') if key in os.environ},
    }
    # Policy comes from the original bundled descriptor. Only the experiment's
    # budget and explicit fixture approval differ between controlled cases.
    policy = json.loads((resources / 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json').read_text())['mcpServers']['cua_repl']
    config = '[mcp_servers.lcu]\nrequired = true\ncommand = ' + json.dumps(command[0]) + '\nargs = ' + json.dumps(command[1:]) + '\n'
    for key in ('enabled_tools', 'omit_tools_from', 'startup_timeout_sec'):
        config += key + ' = ' + json.dumps(policy[key]) + '\n'
    # Prompt + the CLI's explicit `-a never` is a denied approval boundary.
    # The otherwise identical approved action is the positive GUI control.
    config += '[mcp_servers.lcu.tools.js]\noutput_token_limit = ' + str(budget) + '\napproval_mode = ' + json.dumps('prompt' if deny else 'approve') + '\n'
    config += '[mcp_servers.lcu.env]\n' + ''.join(k + ' = ' + json.dumps(v) + '\n' for k, v in env.items())
    config += f'\n[model_providers.fixture]\nname = "Local parity fixture"\nbase_url = "http://127.0.0.1:{server.server_port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n'
    (home / 'config.toml').write_text(config)
    try:
        result = subprocess.run([str(cli), '--strict-config', '-a', 'never', '-c', 'model_provider="fixture"',
            '-c', 'model="fixture"', 'exec', '--ephemeral', '--skip-git-repo-check', '--json', '-C', str(work),
            'Use the lcu js tool to observe this isolated test desktop, then finish.'],
            env={**os.environ, 'CODEX_HOME': str(home)}, capture_output=True, text=True, timeout=120)
        (work / 'run.json').write_text(json.dumps({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert result.returncode == 0 and not errors, (side, result.stderr, errors)
    assert len(requests) == 2, (side, len(requests))
    item = next(i for i in requests[1]['input'] if i.get('type') == 'function_call_output' and i.get('call_id') == 'observe')
    delivered = item['output']
    delivered = delivered if isinstance(delivered, str) else '\n'.join(i.get('text', '') for i in delivered)
    if deny:
        denied = 'MCP tool call requires approval, but approval policy is never'
        assert denied in delivered, delivered
        assert (output/'gui/fallback-click.txt').read_text() == 'untouched', 'Denied tool changed the real GUI'
        return {'tools': next(t for t in requests[0]['tools'] if t.get('name')=='mcp__lcu'),
                'denial_output': denied, 'gui_received_action': False}
    assert 'requires approval' not in delivered and 'failed to connect' not in delivered.lower(), delivered[-1000:]
    guides = runtime / 'lib/node_modules/@oai/cua/docs'
    if budget == policy['tools']['js']['output_token_limit']:
        for guide in ('tinysky-alt-core-cua-repl.md', 'tinysky-alt-confirmations.md'):
            assert (guides / guide).read_text() in delivered, (side, guide)
        assert 'State:' in delivered or 'Apps' in delivered or 'windows' in delivered.lower(), delivered[-500:]
    else:
        assert 'truncated' in delivered and len(delivered) < 3000, (side, len(delivered), delivered[-500:])
    exposed = next(t for t in requests[0]['tools'] if t.get('name') == 'mcp__lcu')
    if action_window is not None:
        deadline = time.monotonic()+5
        while (output/'gui/fallback-click.txt').read_text() == 'untouched' and time.monotonic()<deadline:
            time.sleep(.05)
        assert (output/'gui/fallback-click.txt').read_text() == '40,40', 'Approved positive control did not reach the real GUI'
        return {'tools': exposed, 'gui_received_action': True, 'received_coordinates': [40,40]}
    return {'tools': exposed, 'delivered_chars': len(delivered), 'budget': budget,
            'complete_guides': budget == 25000, 'truncated': 'truncated' in delivered}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('resources', type=Path)
    parser.add_argument('release', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--approval-only', action='store_true', help='Run only the real GUI approval controls')
    args = parser.parse_args()
    assert {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}, 'Requires --network none'
    results = {}
    for budget in (() if args.approval_only else (25000, 100)):
        for side in ('upstream', 'lcu'):
            results[f'{side}-{budget}'] = run(args.resources, args.release, args.output, side, budget)
        assert results[f'upstream-{budget}']['tools'] == results[f'lcu-{budget}']['tools']
    gui = args.output/'gui'
    gui.mkdir()
    oracle = gui/'fallback-click.txt'
    fixture_log = (gui/'fixture.log').open('w')
    fixture = subprocess.Popen([sys.executable, str(Path(__file__).with_name('x11_fixture.py'))],
        env={**os.environ, 'LCU_TEST_OUTPUT':str(gui)}, stdout=fixture_log, stderr=fixture_log)
    try:
        deadline = time.monotonic()+10
        while time.monotonic()<deadline:
            lookup = subprocess.run(['xdotool','search','--onlyvisible','--name','^LCU Fallback$'], capture_output=True, text=True)
            if lookup.returncode==0:
                window = int(lookup.stdout.splitlines()[0]); break
            time.sleep(.05)
        else:
            raise AssertionError('Independent approval GUI did not start')
        for deny in (False, True):
            for side in ('upstream','lcu'):
                oracle.write_text('untouched')
                results[f'{side}-approval-{deny}'] = run(args.resources, args.release, args.output,
                    side, 25000, action_window=window, deny=deny)
            assert results[f'upstream-approval-{deny}'] == results[f'lcu-approval-{deny}']
    finally:
        fixture.terminate()
        fixture.wait(timeout=10)
        fixture_log.close()
    (args.output / 'summary.json').write_text(json.dumps(results, indent=2))
    print('PASS: actual Codex denies fixture GUI actions while identical approved actions succeed; both runtimes' if args.approval_only else
          'PASS: actual Codex model inputs expose only js/js_reset, retain full upstream guides at 25000 tokens, truncate at 100, and deny fixture GUI actions while the identical approved actions succeed; both runtimes')
