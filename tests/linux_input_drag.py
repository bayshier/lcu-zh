"""A translated drag has a time budget that follows its path, and a timed-out one leaves nothing pressed.

LCU bounds every original call (LCU_LINUX_INPUT_CALL_TIMEOUT_MS, here 2 s). A translated drag adds 20 ms per
path point and 2 ms per pixel of path length to that bound, so a long valid drag is not killed halfway; and when
a translated call does time out after it pressed Button1 (or a held modifier), LCU releases what the call itself
pressed with XTEST before it stops the worker, so a later pointer motion cannot continue the drag.

1. An 800-point drag takes 3.5 to 8 s with the original engine (4 to 10 ms per point, by host), longer than the 2 s base
   bound, and must complete with its release delivered (the fixture's drag-end) and the same engine process.
2. A 60-point drag with a held Shift is started; the real engine process is stopped (SIGSTOP) as soon as the X
   server reports Button1 pressed. The call times out at its budget (about 3.3 s). The X server must then report
   no pointer button and no Shift pressed, the drag area must have received the release (drag-end), and the engine
   must be replaced. The oracles are the X server's own input state and the fixture's files.
"""
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
import linux_input_support as support

command = sys.argv[1:] or ['/opt/lcu/current/bin/lcu']
output = Path(os.environ['LCU_TEST_OUTPUT'])
BASE_MS = 2000
SHIFT = 50  # the X key code of Shift_L on a standard keyboard map


def drag_call(count, extra=''):
    path = [{'x': 20 + (index % 200), 'y': 60 + (index % 3)} for index in range(count)]
    return ('try { await sky.drag({window: await byTitle("LCU GTK4 Surface"), path: %s%s}); nodeRepl.write("no error"); }'
            ' catch (error) { nodeRepl.write("error: " + error.message); }') % (json.dumps(path), extra)


(output / 'Gtk4Surface-drag.txt').unlink(missing_ok=True)
support.start_fixture('gtk4_surface_fixture.py')
session = support.Session(command, env={**os.environ, 'LCU_LINUX_INPUT_CALL_TIMEOUT_MS': str(BASE_MS)})
try:
    session.window('LCU GTK4 Surface')
    session.activate('LCU GTK4 Surface')
    root = session.client.process.pid
    session.run('await sky.list_windows();')
    engine = support.engines(root)
    assert engine, 'no original engine process was found under this session'

    started = time.monotonic()
    result = session.run(drag_call(800))
    waited = time.monotonic() - started
    assert result == 'no error', result
    assert waited > BASE_MS / 1000, f'the drag finished within the base bound ({waited:.1f} s); the engine got faster, lengthen it'
    assert support.settle(lambda: support.read('Gtk4Surface-drag.txt') is not None), 'the drag was not delivered'
    assert support.buttons_down() == [], support.buttons_down()
    assert support.engines(root) == engine, 'a successful long drag must not replace the engine'
    print(f'INFO: a 800-point drag took {waited:.1f} s against a {BASE_MS / 1000:.0f} s base bound and completed', flush=True)

    # Hang the engine after the press.
    (output / 'Gtk4Surface-drag.txt').unlink()
    outcome = {}

    def hung_drag():
        try:
            outcome['result'] = session.client.call('tools/call', {'name': 'js', 'arguments': {
                'code': drag_call(60, ', key: "Shift_L"')}}, timeout=90)
        except AssertionError as error:
            outcome['result'] = {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}

    worker = threading.Thread(target=hung_drag)
    worker.start()
    assert support.settle(lambda: 1 in support.buttons_down(), attempts=2000, delay=0.005), 'Button1 was never pressed'
    for pid in engine:
        os.kill(pid, signal.SIGSTOP)
    started = time.monotonic()
    stopped_state = (support.buttons_down(), support.keys_down())
    assert 1 in stopped_state[0] and SHIFT in stopped_state[1], ('the engine stopped before the press', stopped_state)
    worker.join(timeout=60)
    assert not worker.is_alive(), 'the hung drag never returned'
    waited = time.monotonic() - started
    # Read the input state before the engine is resumed: only LCU's own release can have cleared it.
    buttons, keys = support.buttons_down(), support.keys_down()
    for pid in engine:
        try:
            os.kill(pid, signal.SIGCONT)  # a stopped process acts on a pending SIGTERM only once resumed
        except OSError:
            pass
    refused = '\n'.join(item.get('text', '') for item in outcome['result'].get('content', []))
    assert 'no error' not in refused, refused
    print(f'INFO: the hung drag failed {waited:.1f} s after the stop: {refused[:200]}', flush=True)
    assert buttons == [], ('Button1 stayed pressed after the timeout', buttons)
    assert SHIFT not in keys, ('Shift stayed pressed after the timeout', keys)
    assert support.settle(lambda: support.read('Gtk4Surface-drag.txt') is not None), 'the drag area never received the release'
    time.sleep(1.5)
    assert support.buttons_down() == [] and SHIFT not in support.keys_down(), 'a late engine action pressed something again'
    assert support.settle(lambda: not any(support.alive(pid) for pid in engine), attempts=100), 'the hung engine was not stopped'
finally:
    session.close()
    support.stop_fixtures()
print('PASS: a long translated drag completed within its budget, and a drag hung after its press was released before the worker stopped', flush=True)
