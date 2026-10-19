"""Prove native Codex lifecycle events invoke the original runtime's turn-ended handler.

Offline fixture: original Linux CLI + original runtime + local scripted model.
The trusted fixture service only records registration and cleanup; it implements
no computer/browser automation and changes no production runtime code.
"""
import argparse
from contextlib import contextmanager
import http.server
import json
import os
from pathlib import Path
import selectors
import subprocess
import threading
import tomllib
import time

from lcu_node import call as lcu_call


def install_hooks(cli, config, cwd, env, host):
    """What `lcu setup --agent codex` does to the config: LCU's own installHooks, run on Node."""
    lcu_call('codex_hooks', 'installHooks', cli, config, cwd, env, host)


def original_hooks(host):
    return lcu_call('codex_hooks', 'originalHooks', host)


@contextmanager
def app_server(cli, cwd, env):
    """A bare JSON-RPC client of the original `codex app-server` (test tooling: one reader, no threads)."""
    process = subprocess.Popen([str(cli), '--strict-config', 'app-server', '--listen', 'stdio://'], cwd=cwd, env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    state = {'buffer': b'', 'sequence': 0}

    def send(message):
        process.stdin.write(json.dumps(message).encode() + b'\n')
        process.stdin.flush()

    def receive(timeout):
        deadline = time.monotonic() + timeout
        while b'\n' not in state['buffer']:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                return None
            part = process.stdout.read1(65536)
            if not part:
                raise AssertionError('codex app-server exited')
            state['buffer'] += part
        line, state['buffer'] = state['buffer'].split(b'\n', 1)
        message = json.loads(line)
        if 'id' in message and 'method' in message:
            send({'id': message['id'], 'error': {'code': -32601, 'message': 'unsupported'}})
        return message

    def api(method, params, timeout=45):
        state['sequence'] += 1
        request = state['sequence']
        send({'id': request, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = receive(deadline - time.monotonic())
            if message and message.get('id') == request and 'method' not in message:
                assert 'error' not in message, message
                return message['result']
        raise AssertionError(f'codex app-server timed out: {method}')

    api.receive = receive
    try:
        api.initialization = api('initialize', {'clientInfo': {'name': 'lcu-test', 'version': '0'},
                                                'capabilities': {'experimentalApi': True}})
        send({'method': 'initialized'})
        yield api
    finally:
        process.stdin.close()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        selector.close()
        process.stdout.close()


def check(resources, output, scope, enabled, release=None, mode="stop"):
    work = output / (mode if mode != "stop" else scope if enabled else "without-hooks")
    project, home = work / 'project', work / 'home'
    project.mkdir(parents=True)
    (home / '.codex').mkdir(parents=True)
    runtime = release / 'app/resources/cua_node' if release else resources / 'cua_node'
    cli = release / 'app/resources/codex' if release else resources / 'codex'
    host = release / 'app/resources/plugins/openai-bundled' if release else resources / 'plugins/openai-bundled'
    command = [str(release / 'bin/lcu')] if release else [str(runtime / 'bin/node'), str(runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]
    log = work / 'events.jsonl'
    service = work / 'fixture.mjs'
    service.write_text('''import {appendFileSync} from 'node:fs';
export function handleRpc({path}) {
  const meta = nodeRepl.requestMeta;
  appendFileSync(path, JSON.stringify({kind:'registered', meta})+'\\n');
  nodeRepl.addTurnEndedHandler({timeoutMs:4000, run: event => {
    appendFileSync(path, JSON.stringify({kind:'ended', event})+'\\n');
  }});
  return 'Registered original turn-ended handler';
}
''')
    requests, failures, counts = [], [], {}
    second_request, release_model = threading.Event(), threading.Event()

    def call(name, namespace, arguments, call_id):
        return {"id": "fc-" + call_id, "type": "function_call", "call_id": call_id,
                "name": name, "namespace": namespace, "arguments": json.dumps(arguments)}

    def register():
        return call("js", "mcp__lcu", {"code": 'nodeRepl.write(await nodeRepl.rpc("fixture", {path:' + json.dumps(str(log)) + '}));',
                    "title": "Register isolated cleanup fixture"}, "register")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                metadata = json.loads(body['client_metadata']['x-codex-turn-metadata'])
                thread_id = metadata['thread_id']
                counts[thread_id] = counts.get(thread_id, 0) + 1
                step = counts[thread_id]
                child = metadata.get('thread_source') == 'subagent'
                if mode == 'subagent' and not child and step == 1:
                    item = call('spawn_agent', 'multi_agent_v1',
                                {'message': 'LCU_CHILD_FIXTURE: Register the isolated cleanup fixture, then finish.'}, 'spawn')
                elif mode == 'subagent' and not child and step == 2:
                    spawned = next(item for item in body['input'] if item.get('type') == 'function_call_output' and item.get('call_id') == 'spawn')
                    agent_id = json.loads(spawned['output'])['agent_id']
                    item = call('wait_agent', 'multi_agent_v1', {'targets': [agent_id], 'timeout_ms': 10000}, 'wait')
                elif step == 1:
                    item = register()
                elif mode == 'interrupt':
                    second_request.set()
                    release_model.wait(60)
                    self.close_connection = True
                    return
                else:
                    item = {'id': 'message-' + thread_id, 'type': 'message', 'status': 'completed', 'role': 'assistant',
                            'content': [{'type': 'output_text', 'text': 'Fixture complete.', 'annotations': []}]}
                response = {'id': f'r{len(requests)}', 'object': 'response', 'model': 'fixture', 'status': 'completed', 'output': [item],
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
                failures.append(repr(exc))
                self.send_error(500, 'Fixture failed')

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    runtime_env = {
        'CUA_REPL_NODE_REPL_PATH': str(runtime / 'bin/node_repl'),
        'CUA_REPL_ENABLED_SURFACES': 'computer',
        'NODE_REPL_NODE_PATH': str(runtime / 'bin/node'),
        'NODE_REPL_NODE_MODULE_DIRS': str(runtime / 'lib/node_modules'),
        'NODE_REPL_TRUSTED_CODE_PATHS': str(runtime / 'lib/node_modules') + ':' + str(work),
        'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': '@oai/sky/service', 'fixture': str(service)}),
        'NODE_REPL_DISABLE_ANALYTICS': '1', 'CODEX_CLI_PATH': str(cli),
    }
    env = {**os.environ, 'HOME': str(home), 'CODEX_HOME': str(home / '.codex')}
    config = home / '.codex/config.toml' if scope == 'user' else project / '.codex/config.toml'
    config.parent.mkdir(parents=True, exist_ok=True)
    policy = json.loads((host / 'plugins/unified-computer-use/.mcp.json').read_text())['mcpServers']['cua_repl']
    contents = '# Preserve this comment and unrelated policy.\napproval_policy="never"\nsandbox_mode="read-only"\n'
    contents += '[hooks.state."unrelated"]\ntrusted_hash="keep"\nenabled=false\n'
    contents += '[mcp_servers.lcu]\nrequired=true\ncommand=' + json.dumps(command[0]) + '\nargs=' + json.dumps(command[1:]) + '\n'
    for key in ('enabled_tools', 'omit_tools_from', 'startup_timeout_sec'):
        contents += key + '=' + json.dumps(policy[key]) + '\n'
    contents += '[mcp_servers.lcu.tools.js]\noutput_token_limit=25000\napproval_mode="approve"\n'
    contents += '[mcp_servers.lcu.env]\n' + ''.join(key + '=' + json.dumps(value) + '\n' for key, value in runtime_env.items())
    contents += f'[model_providers.fixture]\nname="Local lifecycle fixture"\nbase_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n'
    config.write_text(contents)
    if scope == 'project':
        # Explicit trust applies only to this disposable project fixture. The
        # installer must not grant general project trust to a user's project.
        (home / '.codex/config.toml').write_text('[projects.' + json.dumps(str(project)) + ']\ntrust_level="trusted"\n' + '[model_providers.fixture]' + contents.split('[model_providers.fixture]', 1)[1])
    if enabled:
        before = tomllib.loads(contents)
        install_hooks(cli, config, project, env, host)
        once = config.read_bytes()
        install_hooks(cli, config, project, env, host)
        assert config.read_bytes() == once, 'Hook installation is not byte-idempotent'
        after = tomllib.loads(once.decode())
        assert '# Preserve this comment' in once.decode()
        assert {k: v for k, v in after.items() if k != 'hooks'} == {k: v for k, v in before.items() if k != 'hooks'}
        assert after['hooks']['state']['unrelated'] == before['hooks']['state']['unrelated']
        for event, groups in original_hooks(host).items():
            assert after['hooks'][event] == groups
        if scope == 'project':
            assert not (project / '.codex/state_5.sqlite').exists(), 'Setup polluted project with CLI state'
    if mode == 'overlap':
        install_hooks(cli, home / '.codex/config.toml', project, env, host)
    try:
        if mode == 'interrupt':
            observed = []
            with app_server(cli, project, env) as api:
                thread_info = api('thread/start', {'model': 'fixture', 'modelProvider': 'fixture', 'cwd': str(project),
                                                 'ephemeral': True, 'approvalPolicy': 'never', 'sandbox': 'read-only'})
                thread_id = thread_info['thread']['id']
                turn = api('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'Register the fixture, then wait for interruption.'}]})
                deadline = time.monotonic() + 45
                while not second_request.is_set() and time.monotonic() < deadline:
                    message = api.receive(.2)
                    if message:
                        observed.append(message)
                assert second_request.is_set(), observed
                interrupted = api('turn/interrupt', {'threadId': thread_id, 'turnId': turn['turn']['id']})
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if log.exists() and len(log.read_text().splitlines()) >= 2:
                        break
                    message = api.receive(.2)
                    if message:
                        observed.append(message)
                (work / 'app-server.json').write_text(json.dumps({'initialization': api.initialization, 'thread': thread_info,
                    'turn': turn, 'interrupted': interrupted, 'events': observed,
                    'notifications': [message for message in observed if 'method' in message]}, indent=2))
            result = {'exit': 0, 'stdout': 'native app-server turn/interrupt', 'stderr': ''}
        else:
            prompt = ('Spawn one subagent to register the isolated cleanup fixture, wait for it, then finish.' if mode == 'subagent'
                      else 'Register the isolated lifecycle fixture, then finish.')
            process = subprocess.run([str(cli), '--strict-config', '-a', 'never', '-c', 'model_provider="fixture"', '-c', 'model="fixture"',
                                      'exec', '--ephemeral', '--skip-git-repo-check', '--json', '-C', str(project), prompt],
                                     cwd=project, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
            result = {'exit': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr}
        (work / 'run.json').write_text(json.dumps({**result, 'requests': requests}, indent=2))
    finally:
        release_model.set()
        server.shutdown()
        server.server_close()
        thread.join()
    assert not failures and result['exit'] == 0, (failures, result['stderr'])
    if mode == 'subagent':
        assert len(counts) == 2 and sorted(counts.values())[0] == 2, counts
    else:
        assert len(requests) == 2, requests
    assert log.exists(), requests[-1]['input']
    records = [json.loads(line) for line in log.read_text().splitlines()]
    assert records[0]['kind'] == 'registered', records
    if enabled:
        assert len(records) == 2 and records[1]['kind'] == 'ended', records
        metadata = records[0]['meta']['x-codex-turn-metadata']
        metadata = json.loads(metadata) if isinstance(metadata, str) else metadata
        expected_session = metadata['thread_id'] if metadata.get('thread_source') == 'subagent' and isinstance(metadata.get('thread_id'), str) else metadata['session_id']
        expected_event = {'interrupt': 'Interrupt', 'subagent': 'SubagentStop'}.get(mode, 'Stop')
        assert records[1]['event']['hook_event_name'] == expected_event, records
        assert records[1]['event']['session_id'] == expected_session, records
        if mode == 'subagent':
            assert metadata['thread_source'] == 'subagent' and expected_session != metadata['session_id'], records
        assert records[1]['event']['turn_id'] == metadata['turn_id'], records
    else:
        assert len(records) == 1, records
    return {'scope': scope, 'mode': mode, 'hooks_enabled': enabled, 'events': records}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('resources', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--release', type=Path)
    args = parser.parse_args()
    assert {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}, 'Run with --network none'
    args.output.mkdir(parents=True)
    results = [check(args.resources, args.output, 'user', False, args.release)]
    results += [check(args.resources, args.output, scope, True, args.release) for scope in ('user', 'project')]
    results += [check(args.resources, args.output, scope, True, args.release, mode)
                for scope, mode in [('project', 'overlap'), ('user', 'interrupt'), ('user', 'subagent')]]
    (args.output / 'summary.json').write_text(json.dumps(results, indent=2))
    print('PASS: native Codex Stop, Interrupt, and SubagentStop invoke the original runtime handler with exact live identifiers; overlapping user/project hooks clean up once; without hooks cleanup is absent; installation preserves policy and is idempotent')
