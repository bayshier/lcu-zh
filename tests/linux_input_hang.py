"""A hung original input call is bounded, the worker is replaced, and the late call cannot deliver input.

The original Sky service has no request timeout. LCU bounds every input or focus call it queues
(LCU_LINUX_INPUT_CALL_TIMEOUT_MS) and on a timeout ends the trusted worker, which ends the original engine
process (`sky_linux`), instead of just abandoning the call. This test hangs the real engine by stopping
its process (SIGSTOP; only this session's own descendants are touched), sends a key to the focused GTK 4
entry, and checks that: the call fails promptly with an error, the key never reaches the entry even after
the engine is resumed, the engine process is gone, and the next call is served by a fresh worker. The
oracle for delivery is the entry's file.
"""
import os
from pathlib import Path
import signal
import sys
import time
import linux_input_support as support
from mcp_client import text

command = sys.argv[1:] or ['/opt/lcu/current/bin/lcu']
output = Path(os.environ['LCU_TEST_OUTPUT'])
LIMIT_MS = 3000


# Earlier suites leave their last entry text behind; this fixture starts empty, so start from no file.
(output / 'Gtk4Surface-entry.txt').unlink(missing_ok=True)
support.start_fixture('gtk4_surface_fixture.py')
session = support.Session(command, env={**os.environ, 'LCU_LINUX_INPUT_CALL_TIMEOUT_MS': str(LIMIT_MS)})
try:
    session.window('LCU GTK4 Surface')
    session.activate('LCU GTK4 Surface')
    root = session.client.process.pid
    session.run('await sky.list_windows();')
    before = support.engines(root)
    assert before, 'no original engine process was found under this session'
    for pid in before:
        os.kill(pid, signal.SIGSTOP)
    started = time.monotonic()
    # Either the caught error or, if the worker's exit wins, node_repl's own report of it comes back.
    result = session.client.call('tools/call', {'name': 'js', 'arguments': {
        'code': 'try { await sky.press_key({key: "z"}); nodeRepl.write("no error"); }'
                ' catch (error) { nodeRepl.write("error: " + error.message); }'}}, timeout=60)
    refused = ('' if not result.get('isError') else 'isError: ') + text(result)
    waited = time.monotonic() - started
    for pid in before:
        try:
            os.kill(pid, signal.SIGCONT)  # a stopped process acts on a pending SIGTERM only once resumed
        except OSError:
            pass
    assert 'no error' not in refused and ('did not answer' in refused or result.get('isError')), refused
    assert waited < LIMIT_MS / 1000 + 20, waited
    print(f'INFO: the hung call failed after {waited:.1f} s: {refused[:160]}', flush=True)
    time.sleep(1.5)
    assert support.read('Gtk4Surface-entry.txt') in (None, ''), ('a late key reached the entry', support.read('Gtk4Surface-entry.txt'))
    assert support.settle(lambda: not any(support.alive(pid) for pid in before), attempts=100), 'the hung engine process was not stopped'
    # A fresh worker and engine serve the next request; the old kernel's bindings are gone, so set up again.
    for attempt in range(3):
        try:
            session.run('globalThis.sky = (await import("@oai/sky")).sky;'
                        'globalThis.byTitle = async title => (await sky.list_windows()).find(w => w.title === title);'
                        'nodeRepl.write(String((await sky.list_windows()).length));')
            break
        except AssertionError:
            time.sleep(1)
    else:
        raise AssertionError('the next call after the restart failed')
    session.activate('LCU GTK4 Surface')
    session.run('await sky.press_key({key: "y"});')
    assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'y'), support.read('Gtk4Surface-entry.txt')
    after = support.engines(root)
    assert after and not set(after) & set(before), ('the engine was not replaced', before, after)
finally:
    session.close()
    support.stop_fixtures()
print('PASS: a hung original input call was bounded, the worker and engine were replaced, and no late input arrived', flush=True)
