#!/usr/bin/env python3
"""Verify upstream CODEX_HOME service trust with real native-pipe I/O.

Each side gets a disposable HOME. One case selects HOME/.codex by default and
one selects an explicit CODEX_HOME elsewhere below HOME. A trusted fixture in
the selected home must use the original nativePipe bridge to reach an
independent Unix peer; an otherwise identical fixture outside that home must
be denied the same operation. The test never reads or writes a real Codex home.
"""
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading

from differential_baseline import environment as upstream_environment
from mcp_client import Client

SERVICE = '''export async function handleRpc({path,token}) {
  let connection;
  try {
    connection = await nodeRepl.nativePipe.createConnection(path);
    const reply = await new Promise((resolve,reject) => {
      let bytes = '';
      const deadline = setTimeout(() => reject(Error('fixture peer reply timed out')),5000);
      connection.on('data', data => {
        bytes += Buffer.from(data).toString('utf8');
        if (bytes.includes('\\n')) { clearTimeout(deadline);resolve(bytes); }
      });
      connection.on('error', error => {clearTimeout(deadline);reject(error);});
      connection.write(Buffer.from(token+'\\n'));
    });
    return {ok:true,reply};
  } catch(error) {return {ok:false,error:error.message};}
  finally {connection?.end();}
}'''


def last_value(result):
    return json.loads(next(block['text'] for block in reversed(result['content']) if block['type'] == 'text'))


def serve(listener, token, evidence):
    try:
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(5)
            received = b''
            while not received.endswith(b'\n'):
                part = connection.recv(4096)
                assert part, received
                received += part
            evidence['received'] = received.decode()
            connection.sendall(('ack:' + token + '\n').encode())
    except BaseException as error:
        evidence['error'] = repr(error)


def clean_caller(home, codex_home=None):
    env = dict(os.environ)
    for key in ('CODEX_HOME', 'NODE_REPL_TRUSTED_CODE_PATHS',
                'NODE_REPL_TRUSTED_SERVICES', 'NODE_REPL_NODE_MODULE_DIRS',
                'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS'):
        env.pop(key, None)
    env.update(HOME=str(home), CUA_REPL_ENABLED_SURFACES='browser',
               CUA_REPL_BROWSER_ENV='codex-app', NODE_REPL_DISABLE_ANALYTICS='1')
    if codex_home is not None:
        env['CODEX_HOME'] = str(codex_home)
    return env


def verify_case(side, command, original, selection):
    with tempfile.TemporaryDirectory(prefix='lcu-codex-home-') as directory:
        home = Path(directory) / 'caller-home'
        home.mkdir()
        if selection == 'default':
            selected = home / '.codex'
            caller = clean_caller(home)
        else:
            selected = home / 'selected-codex'
            caller = clean_caller(home, selected)
        trusted = selected / 'services'
        trusted.mkdir(parents=True)
        outside = home / 'outside-selected-home'
        outside.mkdir()
        trusted_service = trusted / 'probe.mjs'
        outside_service = outside / 'probe.mjs'
        trusted_service.write_text(SERVICE)
        outside_service.write_text(SERVICE)

        env = upstream_environment(original, caller) if side == 'upstream' else caller
        env['NODE_REPL_TRUSTED_SERVICES'] = json.dumps({
            'browser': '@oai/browser-desktop/service',
            'trusted-probe': str(trusted_service),
            'outside-probe': str(outside_service),
        })
        socket_path = Path(directory) / 'independent-peer.sock'
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(socket_path))
        listener.listen(4)
        listener.settimeout(5)
        client = Client(command, env=env)
        evidence = {'side': side, 'selection': selection, 'selected_home': str(selected)}
        try:
            def invoke(alias, token):
                code = 'try { const result = await nodeRepl.rpc(' + json.dumps(alias) + ',' + json.dumps({
                    'path': str(socket_path), 'token': token}) + '); nodeRepl.write(JSON.stringify({rpcOk:true,result})); } catch(error) { nodeRepl.write(JSON.stringify({rpcOk:false,error:error.message})); }'
                return last_value(client.js(code))

            denied = invoke('outside-probe', side + '-' + selection + '-outside')
            denied_text = denied.get('error', '') if not denied.get('rpcOk') else denied.get('result', {}).get('error', '')
            assert not denied.get('rpcOk') or denied.get('result', {}).get('ok') is False, denied
            assert any(word in denied_text.lower()
                       for word in ('trust', 'permission', 'allowed', 'denied', 'not permitted')), denied
            try:
                unexpected, _ = listener.accept()
                unexpected.close()
                raise AssertionError('Outside-home service reached the native-pipe peer')
            except socket.timeout:
                pass

            token = side + '-' + selection + '-trusted'
            received = {}
            listener.settimeout(5)
            server = threading.Thread(target=serve, args=(listener, token, received))
            server.start()
            accepted_rpc = invoke('trusted-probe', token)
            server.join(timeout=6)
            assert not server.is_alive(), 'Independent native-pipe peer did not stop'
            assert 'error' not in received, received
            assert received.get('received') == token + '\n', received
            assert accepted_rpc.get('rpcOk') and accepted_rpc.get('result') == {'ok': True, 'reply': 'ack:' + token + '\n'}, accepted_rpc
            evidence.update(outside_denied=denied_text, trusted_result=accepted_rpc['result'],
                            independent_peer_received=received['received'],
                            recovery_after_denial=True)
        finally:
            client.close()
            listener.close()
        return evidence


def exercise(release, original, output):
    commands = {
        'upstream': [str(original / 'bin/node'), str(original / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')],
        'lcu': [str(release / 'bin/lcu')],
    }
    results = {}
    for side, command in commands.items():
        results[side] = [verify_case(side, command, original, selection)
                         for selection in ('default', 'explicit')]
        Path(output).write_text(json.dumps(results, indent=2) + '\n')
    for upstream_case, lcu_case in zip(results['upstream'], results['lcu']):
        assert upstream_case['selection'] == lcu_case['selection']
        assert bool(upstream_case['outside_denied']) == bool(lcu_case['outside_denied'])
        assert upstream_case['trusted_result']['ok'] == lcu_case['trusted_result']['ok']
    print(json.dumps({'original_vs_lcu': 'MATCH', 'cases': len(results['upstream']) * 2,
        'selected_home_modes': ['default HOME/.codex', 'explicit CODEX_HOME'],
        'evidence': 'selected-home service used original nativePipe and an independent Unix peer; sibling service was denied; trusted service recovered'}, indent=2))


if __name__ == '__main__':
    exercise(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
