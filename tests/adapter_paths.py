"""Run the GTK oracle flow through every LCU adapter path, adding no sandbox metadata.

Each harness adapter (Codex relay, Claude relay, the Pi/OMP shared client and the Hermes
bridge) and a bare MCP client talk to the installed `lcu` exactly as a registration would.
None of them is given `codex/sandbox-state-meta`. On a machine where the original node_repl
can sandbox, that used to make every call fail with "Could not connect to X11", so with
LCU_REQUIRE_SANDBOX=1 this also proves that the sandbox is available here, that the failure
reproduces with LCU_NODE_REPL_SANDBOX=host, that by default the kernel stays confined while computer
use works, that a host's stricter profile is honored, and that `off` runs the kernel unsandboxed.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from mcp_client import Client, text

root = Path(os.environ.get('LCU_ADAPTER_ROOT', '/opt/lcu/current'))
command = sys.argv[1:] or [str(root / 'bin/lcu')]
node = str(root / 'app/resources/cua_node/bin/node')
adapters = root / 'adapters'
output = Path(os.environ['LCU_TEST_OUTPUT'])
shim = Path(__file__).resolve().parent / 'adapter_client_shim.mjs'
STRICT = {'permissionProfile': {'type': 'managed', 'file_system': {'type': 'restricted', 'entries': [
    {'path': {'type': 'special', 'value': {'kind': 'root'}}, 'access': 'read'}]}, 'network': 'restricted'},
    'sandboxCwd': 'file:///tmp'}


class Mcp:
    """A bare MCP client or a relay speaking MCP; `prepare` binds per-call identity."""

    def __init__(self, argv, prepare=None, env=None):
        self.client = Client(argv, env=env)
        self.prepare = prepare
        self.calls = 0
        self.initialization = self.client.initialization

    def call_tool(self, name, arguments, meta=None):
        self.calls += 1
        params = {'name': name, 'arguments': arguments}
        merged = dict(meta or {})
        if self.prepare:
            merged.update(self.prepare(self.client, self.calls))
        if merged:
            params['_meta'] = merged
        return self.client.call('tools/call', params, timeout=90)

    def js(self, code, **arguments):
        return self.call_tool('js', {'code': code, **arguments})

    def turn_ended(self):
        return self.call_tool('turn_ended', {'hook_event_name': 'Stop', 'session_id': 'adapter-session',
                                             'turn_id': 'adapter-turn'})

    def close(self):
        self.client.close()


def claude_identity(client, sequence):
    tool_use = f'toolu_adapter_{sequence}'
    client.call('tools/call', {'name': 'set_turn_context', 'arguments': {
        'session_id': 'adapter-session', 'turn_id': 'adapter-turn', 'tool_use_id': tool_use}})
    return {'claudecode/toolUseId': tool_use}


def codex_identity(client, sequence):
    return {'x-codex-turn-metadata': {'session_id': 'adapter-session', 'turn_id': 'adapter-turn',
                                      'call_id': f'call-{sequence}'}}


class Lines:
    """A newline-delimited JSON helper process: the shared client shim or the Hermes bridge."""

    def __init__(self, argv):
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.sequence = 0

    def request(self, **payload):
        self.sequence += 1
        self.process.stdin.write(json.dumps({'id': self.sequence, **payload}) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        assert line, 'helper process ended'
        response = json.loads(line)
        assert response['id'] == self.sequence, response
        return response

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)


class SharedClient(Lines):
    """adapters/client.mjs, the transport of the Pi extension, Oh My Pi and Hermes."""

    def __init__(self):
        super().__init__([node, str(shim), str(adapters / 'client.mjs'), *command])
        self.initialization = self.request(type='connect')['result']

    def call_tool(self, name, arguments):
        response = self.request(type='call', name=name, arguments=arguments)
        assert response['ok'], response
        return response['result']

    def js(self, code, **arguments):
        return self.call_tool('js', {'code': code, **arguments})

    def turn_ended(self):
        response = self.request(type='turnEnded')
        assert response['ok'], response
        return response['result']


class HermesBridge(Lines):
    """adapters/hermes/bridge.mjs, driven with the requests the Hermes plugin sends."""

    def __init__(self):
        super().__init__([node, str(adapters / 'hermes/bridge.mjs')])
        self.initialization = self.request(type='connect', command=command)['result']

    def call_tool(self, name, arguments):
        response = self.request(type='call', name=name, arguments=arguments,
                                sessionId='adapter-session', turnId='adapter-turn', toolCallId='adapter-call')
        assert response['ok'], response
        return response['result']

    def js(self, code, **arguments):
        return self.call_tool('js', {'code': code, **arguments})

    def turn_ended(self):
        response = self.request(type='turnEnded', sessionId='adapter-session', turnId='adapter-turn', event='Stop')
        assert response['ok'], response
        return response['result']


def run(transport, code, error=False):
    result = transport.js(code)
    assert bool(result.get('isError')) == error, (code, result)
    return text(result)


def element(state, label):
    line = next(line for line in state.splitlines() if label in line)
    match = re.search(r'\[(\d+)\]', line) or re.search(r'^\s*(\d+)\b', line)
    assert match, line
    return match.group(1)


def gtk_flow(transport, name):
    """Drive the independent GTK fixture and compare its saved file, as integration.py does."""
    run(transport, 'await cua.getState();')
    for attempt in range(50):
        windows = json.loads(run(transport, 'nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));'))
        target = next((w for w in windows if w.get('title') == 'LCU Target'), None)
        if target:
            break
        time.sleep(0.2)
    assert target, windows
    state = run(transport, f'let app = await cua.getApp({{windowId:{target["id"]}}});')
    assert 'at_spi' in state, state
    expected = f'{name} café ✓'
    state = run(transport, f'await app.click({json.dumps(element(state, "Draft text"))}); '
                           f'await app.pressKey("ctrl+a"); await app.typeText({json.dumps(expected)}); await app.getAXState();')
    assert expected in state, state
    saved = run(transport, f'await app.click({json.dumps(element(state, "Save draft"))}); await app.getAXState();')
    assert 'Saved: ' + expected in saved, saved
    assert (output / 'Target.txt').read_text() == expected
    # Keys and paste go through the same window-targeted input path.
    second = f'{name} second Δ'
    state = run(transport, f'await app.click({json.dumps(element(saved, "Draft text"))}); '
                           f'await app.pressKey("ctrl+a"); await app.paste({json.dumps(second)}); await app.getAXState();')
    assert second in state, state
    run(transport, f'await app.click({json.dumps(element(state, "Save draft"))}); await app.getAXState();')
    assert (output / 'Target.txt').read_text() == second
    # Window-targeted keys and clicks reach a GTK 4 window through LCU's translation on every adapter path.
    gtk4_window_flow(transport)
    # Cleanup reaches the original server without metadata and must succeed; the next real computer-use call must
    # not be reset or sandboxed, and the kernel's state persists across turn_ended.
    run(transport, f'globalThis.adapterSentinel = {json.dumps(name)}; nodeRepl.write("set");')
    ended = transport.turn_ended()
    assert isinstance(ended, dict) and not ended.get('isError'), ended
    assert run(transport, 'nodeRepl.write(globalThis.adapterSentinel);') == name
    windows = json.loads(run(transport, 'nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));'))
    assert any(w.get('title') == 'LCU Target' for w in windows), windows
    state = run(transport, 'await cua.getState();')
    assert 'LCU Target' in state or 'window' in state.lower(), state[:400]


def gtk4_window_flow(transport):
    """app.pressKey and app.click on GTK 4 windows, observed through the fixture's own files."""
    windows = json.loads(run(transport, 'nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));'))
    entry = next(w for w in windows if w.get('title') == 'LCU GTK4 Entry')
    button = next(w for w in windows if w.get('title') == 'LCU GTK4 Button')
    gtk4_entry = output / 'Gtk4-entry.txt'
    gtk4_click = output / 'Gtk4-click'
    gtk4_click.unlink(missing_ok=True)
    run(transport, f'let gtk4 = await cua.getApp({{windowId:{entry["id"]}}}); '
                   'await gtk4.pressKey("ctrl+a"); await gtk4.pressKey("BackSpace"); await gtk4.pressKey("w");')
    deadline = time.time() + 5
    while time.time() < deadline and not (gtk4_entry.exists() and gtk4_entry.read_text() == 'w'):
        time.sleep(0.1)
    assert gtk4_entry.exists() and gtk4_entry.read_text() == 'w', gtk4_entry.read_text() if gtk4_entry.exists() else None
    run(transport, f'let gtk4Button = await cua.getApp({{windowId:{button["id"]}}}); await gtk4Button.click([150, 80]);')
    deadline = time.time() + 5
    while time.time() < deadline and not gtk4_click.exists():
        time.sleep(0.1)
    assert gtk4_click.exists(), 'window-targeted click did not reach GTK 4'
    gtk4_click.unlink()


def sandbox_available():
    """The original runtime advertises sandbox-state metadata only where it can sandbox."""
    probe = Mcp(command, env={**os.environ, 'LCU_NODE_REPL_SANDBOX': 'host'})
    try:
        return 'codex/sandbox-state-meta' in probe.initialization.get('capabilities', {}).get('experimental', {})
    finally:
        probe.close()


WRITE_PROBE = ('const fs = await import("node:fs"); try { fs.writeFileSync(%s, "x"); nodeRepl.write("ALLOWED"); } '
               'catch (e) { nodeRepl.write("REFUSED " + (e.code || e.message)); }')


def sandbox_controls():
    # Negative control: LCU_NODE_REPL_SANDBOX=host keeps the original failure on a sandbox-capable machine.
    declined = Mcp(command, env={**os.environ, 'LCU_NODE_REPL_SANDBOX': 'host'})
    try:
        declined.js('await cua.getState();')
        result = declined.js('nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));')
        assert result.get('isError') and 'Could not connect to X11' in text(result), text(result)[-400:]
    finally:
        declined.close()
    # The default: the model's kernel stays sandboxed while computer use works, with no host sandbox metadata.
    marker = output / 'kernel-write-probe'
    marker.unlink(missing_ok=True)
    boxed = Mcp(command)
    try:
        boxed.js('await cua.getState();')
        assert not boxed.js('await cua.listWindows({emit:false});').get('isError')
        refused = text(boxed.js(WRITE_PROBE % json.dumps(str(marker))))
        assert 'REFUSED' in refused and not marker.exists(), refused
        # A host that deliberately sends a stricter profile keeps it, and computer use still works.
        result = boxed.call_tool('js', {'code': 'nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));'},
                                 meta={'codex/sandbox-state-meta': STRICT})
        assert not result.get('isError'), text(result)[-400:]
    finally:
        boxed.close()
    # `off` is the explicit opt-out: the kernel runs without a sandbox.
    unboxed = Mcp(command, env={**os.environ, 'LCU_NODE_REPL_SANDBOX': 'off'})
    try:
        assert not unboxed.js('await cua.listWindows({emit:false});').get('isError')
        allowed = text(unboxed.js(WRITE_PROBE % json.dumps(str(marker))))
        assert 'ALLOWED' in allowed and marker.exists(), allowed
        marker.unlink()
    finally:
        unboxed.close()
    print('PASS: sandbox negative control, confined kernel with computer use, stricter host profile, off', flush=True)


if os.environ.get('LCU_REQUIRE_SANDBOX') == '1':
    assert sandbox_available(), 'LCU_REQUIRE_SANDBOX=1 but the original node_repl cannot sandbox in this container'
    sandbox_controls()
paths = {
    'bare MCP client': lambda: Mcp(command),
    'Codex relay': lambda: Mcp([node, str(adapters / 'codex.mjs'), *command], codex_identity),
    'Claude relay': lambda: Mcp([node, str(adapters / 'claude.mjs'), *command], claude_identity),
    'Pi/OMP shared client': SharedClient,
    'Hermes bridge': HermesBridge,
}
for label, create in paths.items():
    transport = create()
    try:
        gtk_flow(transport, label.split()[0].lower())
    finally:
        if isinstance(transport, (SharedClient, HermesBridge)):
            transport.request(type='close')
        transport.close()
    print(f'PASS: GTK flow through {label}', flush=True)
