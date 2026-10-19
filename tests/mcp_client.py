"""Small protocol test client; no dependency on LCU implementation details."""
import json
import selectors
import subprocess
import time


class Client:
    def __init__(self, command, env=None, request_handler=None,
                 protocol_version='2024-11-05', capabilities=None, stderr=None):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, env=env)
        self.buffer = b''
        self.sequence = 0
        self.request_handler = request_handler
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.initialization = self.call('initialize', {'protocolVersion': protocol_version,
                                'capabilities': capabilities if capabilities is not None else {},
                                'clientInfo': {'name': 'lcu-verification', 'version': '1'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b'\n')
        self.process.stdin.flush()

    def call(self, method, params, timeout=45):
        self.sequence += 1
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                message = json.loads(line)
                if message.get('id') == self.sequence and 'method' not in message:
                    if 'error' in message:
                        raise AssertionError(message['error'])
                    return message['result']
                if 'id' in message and 'method' in message:
                    if self.request_handler is None:
                        raise AssertionError(f'Unexpected server request: {message["method"]}')
                    result = self.request_handler(message['method'], message.get('params', {}))
                    self.send({'jsonrpc': '2.0', 'id': message['id'], 'result': result})
            if self.selector.select(max(0, deadline - time.monotonic())):
                data = self.process.stdout.read1(65536)
                if not data:
                    raise AssertionError('MCP process closed stdout')
                self.buffer += data
        raise AssertionError(f'MCP timeout: {method}')

    def js(self, code, error=False, **arguments):
        result = self.call('tools/call', {'name': 'js', 'arguments': {'code': code, **arguments}})
        assert bool(result.get('isError')) == error, result
        return result

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.selector.close()


def text(result):
    return '\n'.join(item['text'] for item in result['content'] if item['type'] == 'text')
