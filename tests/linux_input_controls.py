"""Window-targeted input that LCU must leave on the original path: GTK 3, a toolkit-less X11 window,
a Chromium-like process, and Qt keys/click; plus Qt scroll, which is the one Qt action translated.

The oracles are files the independent fixtures write. "Unchanged" means two things: the input still arrives
and the focused window stays the same, because the original engine delivers it without activating anything.
"""
import os
import sys
import time
import linux_input_support as support

command = sys.argv[1:] or ['/opt/lcu/current/bin/lcu']


def main():
    support.start_fixture('qt_fixture.py', QT_QPA_PLATFORM='xcb')
    support.start_fixture('gtk4_surface_fixture.py', '--chromium-like')
    session = support.Session(command)
    try:
        qt = session.window('LCU Qt Surface')
        chromium = session.window('LCU GTK4 Chromium-like')
        other = session.window('LCU Other')
        fallback = session.window('LCU Fallback')
        anchor = session.activate('LCU Target')

        # GTK 3: a coordinate click on an unfocused window still lands and does not take focus.
        session.run(f'await sky.click({{window: await byTitle("LCU Other"), x: 240, y: 85}});')
        assert support.settle(lambda: support.read('Other.txt') == 'untouched'), support.read('Other.txt')
        assert session.focused_id() == anchor['id'], 'a GTK 3 click must not change the focused window'

        # A toolkit-less X11 window (core events only): the click arrives with its window-relative coordinates.
        path = support.output / 'fallback-click.txt'
        if path.exists():
            path.unlink()
        session.run('await sky.click({window: await byTitle("LCU Fallback"), x: 30, y: 40});')
        assert support.settle(path.exists) and path.read_text() == '30,40', path.read_text() if path.exists() else None
        assert session.focused_id() == anchor['id'], 'a click on a core-event window must not change focus'

        # Qt: keys and click are accepted by the original path without activation.
        session.run('await sky.press_key({window: await byTitle("LCU Qt Surface"), key: "k"});')
        assert support.settle(lambda: support.read('Qt-entry.txt') == 'k'), support.read('Qt-entry.txt')
        assert session.focused_id() == anchor['id'], 'Qt keys must not change the focused window'

        # Chromium-like: a GTK 4 library is mapped but icudtl.dat marks a Chromium/Electron process, which handles
        # XSendEvent itself. LCU must not translate: no activation, so focus stays where it was.
        session.run('await sky.press_key({window: await byTitle("LCU GTK4 Chromium-like"), key: "q"});')
        time.sleep(1)
        assert session.focused_id() == anchor['id'], 'a Chromium-like process must not be activated by LCU'

        # Control: with the translation off, the original engine's window-targeted Qt scroll has no effect, so the
        # offset check below proves the translation rather than a scrollable fixture that always moves.
        off = support.Session(command, env={**os.environ, 'LCU_LINUX_INPUT_TRANSLATION': 'off'})
        try:
            off.run('await sky.scroll({window: await byTitle("LCU Qt Surface"), x: 200, y: 330, direction: "down", pixels: 300});')
            time.sleep(1)
            assert support.read('Qt-scroll.txt') is None, 'the original path scrolled Qt: record native_input in tested-versions.json'
            assert off.focused_id() == anchor['id']
        finally:
            off.close()
        # Qt scroll is the translated Qt action: the offset changes and the window ends up focused.
        session.run('await sky.scroll({window: await byTitle("LCU Qt Surface"), x: 200, y: 330, direction: "down", pixels: 300});')
        assert support.settle(lambda: int(support.read('Qt-scroll.txt') or 0) > 0), support.read('Qt-scroll.txt')
        assert session.focused_id() == qt['id']
        # Qt click: window-targeted, original path.
        session.activate('LCU Target')
        click_y = 56
        session.run(f'await sky.click({{window: await byTitle("LCU Qt Surface"), x: 200, y: {click_y}}});')
        assert support.settle(lambda: (support.output / 'Qt-click').exists()), 'a Qt click did not arrive'
        # Focus is not asserted here: Qt may take focus for a click on its own, which is not LCU activating it.
    finally:
        session.close()
        support.stop_fixtures()
    print('PASS: unchanged GTK 3, X11, Qt keys/click and Chromium-like input; Qt scroll translated', flush=True)


main()
