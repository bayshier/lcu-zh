#!/usr/bin/env python3
"""Real Linux native-pipe failures/recovery and connect-vs-read timeout scope.

The temporary trusted fixture calls the original nativePipe bridge, the same
entry point used by upstream browser transport hf.create. It implements no
browser engine, auth policy or native transport. A separate Python Unix peer
records actual bytes and response timing. Linux backlog saturation yields EAGAIN
rather than delayed connect; this suite does not claim timer-expiration coverage.
"""
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time

from differential_baseline import environment as upstream_environment
from mcp_client import Client

SERVICE = '''export async function handleRpc({path,token}) {
  const begin = performance.now();
  let connection;
  try {
    connection = await nodeRepl.nativePipe.createConnection(path);
    const connectedMs = performance.now() - begin;
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
    return {ok:true,connectedMs,elapsedMs:performance.now()-begin,reply};
  } catch(error) {return {ok:false,elapsedMs:performance.now()-begin,error:error.message};}
  finally {connection?.end();}
}'''


def last_value(result):
    return json.loads(next(block['text'] for block in reversed(result['content']) if block['type'] == 'text'))


def peer(listener, token, delay, evidence):
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
            evidence['received_at'] = time.monotonic()
            time.sleep(delay)
            connection.sendall(('ack:' + token + '\n').encode())
            evidence['replied_at'] = time.monotonic()
    except BaseException as error:
        evidence['error'] = repr(error)


def exercise(release, original, output):
    commands = {
        'upstream': [str(original / 'bin/node'), str(original / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')],
        'lcu': [str(release / 'bin/lcu')],
    }
    results = {}
    with tempfile.TemporaryDirectory(prefix='lcu-pipe-fixture-') as directory:
        scratch = Path(directory)
        service = scratch / 'transport-probe.mjs'
        service.write_text(SERVICE)
        for side, command in commands.items():
            results[side] = {}
            for configuration, timeout in (('host-default', None), ('alternate-100ms', '100'), ('malformed', 'invalid')):
                caller = dict(os.environ, CUA_REPL_ENABLED_SURFACES='browser',
                              CUA_REPL_BROWSER_ENV='codex-app', NODE_REPL_DISABLE_ANALYTICS='1')
                caller.pop('NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS', None)
                if timeout is not None:
                    caller['NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS'] = timeout
                caller['NODE_REPL_TRUSTED_SERVICES'] = json.dumps({
                    'browser': '@oai/browser-desktop/service', 'fixture-pipe': str(service)})
                env = upstream_environment(original, caller) if side == 'upstream' else caller
                # This exact temporary fixture directory is trusted only in the
                # test process. No production trust configuration is changed.
                env['NODE_REPL_TRUSTED_CODE_PATHS'] = os.pathsep.join(filter(None, (
                    env.get('NODE_REPL_TRUSTED_CODE_PATHS'), str(scratch))))
                path = scratch / (side + '-' + configuration + '.sock')
                listener = socket.socket(socket.AF_UNIX)
                listener.bind(str(path))
                listener.listen(0)
                listener.settimeout(5)
                client = Client(command, env=env)
                case = {}
                try:
                    def connect(token):
                        return last_value(client.js('nodeRepl.write(JSON.stringify(await nodeRepl.rpc('
                            '"fixture-pipe",' + json.dumps({'path': str(path), 'token': token}) + ')));'))
                    if configuration == 'malformed':
                        failure = connect('invalid-option')
                        assert not failure['ok'], failure
                        assert 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS' in failure['error'], failure
                        assert 'integer number of milliseconds' in failure['error'], failure
                        listener.settimeout(.05)
                        try:
                            unexpected, _ = listener.accept()
                            unexpected.close()
                            raise AssertionError('Malformed timeout still connected to peer')
                        except socket.timeout:
                            pass
                        case['malformed_rejected_without_connect'] = failure
                        continue
                    def echo(token, delay):
                        observed = {}
                        receiver = threading.Thread(target=peer, args=(listener, token, delay, observed))
                        receiver.start()
                        outcome = connect(token)
                        receiver.join(timeout=6)
                        assert not receiver.is_alive(), 'Fixture peer did not stop'
                        assert 'error' not in observed, observed
                        assert observed['received'] == token + '\n', observed
                        assert outcome['ok'] and outcome['reply'] == 'ack:' + token + '\n', outcome
                        peer_delay_ms = (observed['replied_at'] - observed['received_at']) * 1000
                        return outcome, peer_delay_ms
                    case['successful_control'], _ = echo(side + '-' + configuration + '-control', 0)
                    # A real queued connection occupies the complete Linux
                    # listen(0) backlog. The original nonblocking connect fails.
                    with socket.socket(socket.AF_UNIX) as filler:
                        filler.connect(str(path))
                        rejected = connect('must-not-arrive')
                        assert not rejected['ok'], rejected
                        assert 'Resource temporarily unavailable (os error 11)' in rejected['error'], rejected
                        case['backlog_rejection'] = rejected
                        queued, _ = listener.accept()
                        queued.close()
                    # Same original MCP process recovers once backlog is free.
                    # Delay the peer response beyond the alternate connect
                    # timeout, proving it does not impose a read/RPC deadline.
                    recovered, peer_delay_ms = echo(side + '-' + configuration, .35)
                    assert peer_delay_ms >= 300, peer_delay_ms
                    assert recovered['elapsedMs'] >= 300, recovered
                    case['recovery_delayed_reply'] = recovered
                    case['peer_delay_ms'] = peer_delay_ms
                    case['independent_peer_received_expected_bytes'] = True
                finally:
                    client.close()
                    listener.close()
                    results[side][configuration] = case
                    Path(output).write_text(json.dumps(results, indent=2) + '\n')
    assert results.keys() == commands.keys()
    for configuration in results['upstream']:
        a, b = [results[side][configuration] for side in commands]
        assert a.keys() == b.keys(), configuration
        if configuration == 'malformed':
            assert a['malformed_rejected_without_connect']['error'] == b['malformed_rejected_without_connect']['error']
        else:
            assert a['backlog_rejection']['error'] == b['backlog_rejection']['error']
    print(json.dumps({'original_vs_lcu': 'MATCH', 'configurations': 3,
        'independent_unix_peer': 'backlog failure; recovery; bytes and delayed response verified',
        'connect_timeout_expiration': 'NOT COVERED: real Linux backlog returns EAGAIN immediately'}, indent=2))


if __name__ == '__main__':
    exercise(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
