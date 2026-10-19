"""Check what input reaches GTK 4 windows through LCU and the original runtime, with file oracles.

GTK 4 only reads input through XInput2. The original Linux engine sends a window-targeted
`pressKey`/`click`/`scroll`/`drag` as core X events with XSendEvent, "without activating" the window,
so a GTK 4 window never sees them. Desktop-level input (no `window`) uses the X server's XTEST path and
reaches GTK 4 normally, as xdotool does. AT-SPI actions and (in recent engines) `typeText` use neither path.
This test pins the desktop-level paths, then proves that LCU's Linux input translation
(lcu/linux_sky_service.mjs) makes the window-targeted calls work for GTK 4: keys, coordinate click, scroll,
drag, an override-redirect overlay covering the target (refused, nothing reaches the overlay), a modal dialog, that concurrent calls cannot interleave, and that `LCU_LINUX_INPUT_TRANSLATION=off` restores the original behavior.
The oracles are files the independent fixtures write, never a call's success.
"""
import json
import os
from pathlib import Path
import sys
import time
from mcp_client import Client, text
import linux_input_support as support

command = sys.argv[1:] or ['/opt/lcu/current/bin/lcu']
output = Path(os.environ['LCU_TEST_OUTPUT'])
client = Client(command)


def run(code, error=False):
    return text(client.js(code, error=error))


def entry_text():
    path = output / 'Gtk4-entry.txt'
    return path.read_text() if path.exists() else ''


def settle(predicate, attempts=30):
    for _ in range(attempts):
        if predicate():
            return True
        time.sleep(0.1)
    return False


def window_targeted(command):
    """Window-targeted input to GTK 4 windows, through `sky.*` and the `app.*` helpers."""
    support.start_fixture('gtk4_surface_fixture.py')
    session = support.Session(command)
    try:
        surface = session.window('LCU GTK4 Surface')
        entry_window = session.window('LCU GTK4 Entry')
        button_window = session.window('LCU GTK4 Button')
        # Start from a different focused window: the translation must focus the target itself.
        session.activate('LCU GTK4 Button')
        session.run(f'await sky.press_key({{window: await byTitle("LCU GTK4 Surface"), key: "x"}});')
        assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'x'), support.read('Gtk4Surface-entry.txt')
        assert session.focused_id() == surface['id'], 'the translated key should leave the target focused'
        # The app helpers use the same path: chord, Return through the entry, and BackSpace.
        session.run(f'let app = await cua.getApp({{windowId:{surface["id"]}}});'
                    'await app.pressKey("ctrl+a"); await app.pressKey("BackSpace");')
        assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == ''), support.read('Gtk4Surface-entry.txt')
        session.run('await app.pressKey("y");')
        assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'y')
        session.run('await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "shift+k"});')
        assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'yK'), support.read('Gtk4Surface-entry.txt')
        # key_down/key_up (engines from CUA 0.0.27 on) are never translated: they reach the original engine
        # unchanged, which delivers them with XSendEvent, so GTK 4 ignores the hold, nothing is focused or left
        # held at the desktop, and the next key is not shifted.
        if session.run('nodeRepl.write(typeof sky.key_down === "function" ? "yes" : "no");') == 'yes':
            session.activate('LCU GTK4 Entry')
            session.run('await sky.key_down({window: await byTitle("LCU GTK4 Surface"), key: "shift"});'
                        'await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "k"});'
                        'await sky.key_up({window: await byTitle("LCU GTK4 Surface"), key: "shift"});')
            assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'yKk'), support.read('Gtk4Surface-entry.txt')
            session.run('await sky.press_key({key: "j"});')
            assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'yKkj'), support.read('Gtk4Surface-entry.txt')
            session.run('await sky.press_key({key: "ctrl+a"}); await sky.press_key({key: "BackSpace"});')
            assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == '')
        else:
            print('INFO: this engine has no key_down/key_up; pass-through not exercised', flush=True)
            session.run('await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "ctrl+a"});'
                        'await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "BackSpace"});')
            assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == '')

        # Serialization: a translated key to the Surface racing activate_window of another window, in both orders; the
        # Entry window (the other contender) must never receive the Surface's key. Then a desktop-level key (an
        # untranslated call) issued together with a translated one must come after it, in the same window.
        entry_before = entry_text()
        for order in range(4):
            session.activate('LCU GTK4 Entry')
            calls = ['sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "r"})',
                     'sky.activate_window({window: await byTitle("LCU GTK4 Entry")})']
            if order % 2:
                calls.reverse()
            session.run(f'await Promise.all([{",".join(calls)}]);')
            time.sleep(0.3)
            assert entry_text() == entry_before, ('a key reached the Entry window', order, entry_text())
            session.activate('LCU GTK4 Surface')
            session.run('await sky.press_key({key: "ctrl+a"}); await sky.press_key({key: "BackSpace"});')
            assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == '')
        session.activate('LCU GTK4 Entry')
        session.run('await Promise.all([sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "q"}),'
                    'sky.press_key({key: "w"})]);')
        assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'qw'), \
            ('the desktop-level key overtook the translated key', support.read('Gtk4Surface-entry.txt'), entry_text())
        assert entry_text() == entry_before
        session.run('await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "ctrl+a"});'
                    'await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "BackSpace"});')
        assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == '')
        session.run('await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "y"});')
        assert support.settle(lambda: support.read('Gtk4Surface-entry.txt') == 'y')

        # Coordinate click on another, unfocused window: window-relative coordinates.
        session.activate('LCU GTK4 Surface')
        session.run(f'let button = await cua.getApp({{windowId:{button_window["id"]}}});'
                    'await button.click([150, 80]);')
        assert support.settle(lambda: (support.output / 'Gtk4-click').exists()), 'window-targeted click did not reach GTK 4'
        (support.output / 'Gtk4-click').unlink()
        assert session.focused_id() == button_window['id']
        # An AT-SPI element action is not translated and still works.
        state = session.run('nodeRepl.write(await button.getAXState());')
        assert 'Press' in state, state

        # An override-redirect window (a notification, a tooltip, a popup) covering the focused target at the
        # click point: XTEST would click the overlay, so LCU asks the X server what is under the point and refuses.
        # The target is already focused, so no activation re-raises it above the overlay.
        support.start_fixture('x11_overlay_fixture.py')
        assert support.settle(lambda: support.read('overlay-state') == 'hidden'), 'the overlay fixture did not start'
        button_window = session.window('LCU GTK4 Button')
        (support.output / 'overlay-show').write_text(
            f'{button_window["x"] + 100},{button_window["y"] + 50},120,80')
        assert support.settle(lambda: support.read('overlay-state') == 'shown')
        time.sleep(0.3)
        for call in ('click({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80})',
                     'click({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80, click_count: 2})',
                     'move({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80})',
                     'scroll({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80, direction: "down", pixels: 50})',
                     'drag({window: await byTitle("LCU GTK4 Button"), path: [{x: 150, y: 80}, {x: 160, y: 85}]})'):
            covered = session.run(f'try {{ await sky.{call}; nodeRepl.write("no error"); }}'
                                  ' catch (error) { nodeRepl.write("error: " + error.message); }')
            assert covered.startswith('error: ') and 'Another window covers' in covered, (call, covered)
        time.sleep(0.5)
        assert not (support.output / 'Gtk4-click').exists(), 'a click reached GTK 4 through the overlay'
        assert support.read('overlay-click.txt') is None, ('input reached the overlay', support.read('overlay-click.txt'))
        # Away from the overlay the same target still takes the click, and with the overlay gone the original point works.
        session.run('await button.click([20, 20]);')
        assert support.settle(lambda: (support.output / 'Gtk4-click').exists()), 'a click beside the overlay did not arrive'
        (support.output / 'Gtk4-click').unlink()
        (support.output / 'overlay-hide').write_text('1')
        assert support.settle(lambda: support.read('overlay-state') == 'hidden')
        time.sleep(0.3)
        session.run('await button.click([150, 80]);')
        assert support.settle(lambda: (support.output / 'Gtk4-click').exists()), 'a click did not arrive once the overlay left'
        (support.output / 'Gtk4-click').unlink()
        assert support.read('overlay-click.txt') is None
        # An active pointer grab by another client (a popup menu does this) sends every click to that client
        # even though the window under the pointer is the target. The popup here is mapped away from the point.
        (support.output / 'overlay-show').write_text('960,720,40,30')
        assert support.settle(lambda: support.read('overlay-state') == 'shown')
        (support.output / 'overlay-grab').write_text('1')
        assert support.settle(lambda: support.read('overlay-grab-state') == 'held'), support.read('overlay-grab-state')
        time.sleep(0.3)
        for call in ('click({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80})',
                     'click({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80, click_count: 2})',
                     'move({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80})',
                     'scroll({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80, direction: "down", pixels: 50})',
                     'drag({window: await byTitle("LCU GTK4 Button"), path: [{x: 150, y: 80}, {x: 160, y: 85}]})'):
            grabbed = session.run(f'try {{ await sky.{call}; nodeRepl.write("no error"); }}'
                                  ' catch (error) { nodeRepl.write("error: " + error.message); }')
            assert grabbed.startswith('error: ') and 'active pointer grab' in grabbed, (call, grabbed)
        time.sleep(0.5)
        assert not (support.output / 'Gtk4-click').exists(), 'a click reached GTK 4 during the grab'
        assert support.read('overlay-click.txt') is None, ('input reached the grabbing popup', support.read('overlay-click.txt'))
        # The probe grab must not disturb the popup's own grab, nor leave one behind once it is dropped.
        (support.output / 'overlay-ungrab').write_text('1')
        assert support.settle(lambda: support.read('overlay-grab-state') == 'released')
        (support.output / 'overlay-hide').write_text('1')
        assert support.settle(lambda: support.read('overlay-state') == 'hidden')
        time.sleep(0.3)
        session.run('await button.click([150, 80]);')
        assert support.settle(lambda: (support.output / 'Gtk4-click').exists()), 'a click did not arrive once the grab was dropped'
        (support.output / 'Gtk4-click').unlink()
        assert support.read('overlay-click.txt') is None
        # An AT-SPI element action is not translated and still works.
        state = session.run('nodeRepl.write(await button.getAXState());')
        assert 'Press' in state, state

        # Scroll over the scrolled area: coordinates relative to the surface window (client origin).
        session.run('await app.scroll([200, 330], "down", {pixels: 300});')
        assert support.settle(lambda: int(support.read('Gtk4Surface-scroll.txt') or 0) > 0), support.read('Gtk4Surface-scroll.txt')
        # Drag inside the drag area.
        session.run('await app.drag([40, 70], [190, 100]);')
        assert support.settle(lambda: support.read('Gtk4Surface-drag.txt') is not None), 'drag did not reach GTK 4'
        dx, dy = map(int, support.read('Gtk4Surface-drag.txt').split(','))
        assert 120 <= dx <= 180 and 15 <= dy <= 45, (dx, dy)

        # A modal dialog owned by the target receives keys addressed to its parent.
        before = support.read('Gtk4Surface-entry.txt')
        (support.output / 'Gtk4Surface-open-modal').write_text('1')
        modal = session.window('LCU GTK4 Modal')
        session.activate('LCU GTK4 Entry')
        session.run(f'await sky.press_key({{window: await byTitle("LCU GTK4 Surface"), key: "m"}});')
        assert support.settle(lambda: support.read('Gtk4Surface-modal-entry.txt') == 'm'), support.read('Gtk4Surface-modal-entry.txt')
        assert support.read('Gtk4Surface-entry.txt') == before, 'the parent received a key meant for the modal dialog'
        assert session.focused_id() == modal['id']
        # Pointer input to the parent of a modal dialog is refused (the parent's coordinates do not describe the
        # dialog); the dialog itself can still be targeted explicitly.
        refused = session.run('try { await sky.click({window: await byTitle("LCU GTK4 Surface"), x: 40, y: 40}); nodeRepl.write("no error"); }'
                              ' catch (error) { nodeRepl.write("error: " + error.message); }')
        assert refused.startswith('error: ') and 'modal' in refused, refused
        assert session.focused_id() == modal['id']
        (support.output / 'Gtk4Surface-close-modal').write_text('1')
        assert support.settle(lambda: all(w.get('title') != 'LCU GTK4 Modal' for w in session.windows()))
        session.activate('LCU GTK4 Entry')

        # A point outside the target window's client rectangle is refused instead of clicking whatever is there.
        outside = session.run('try { await sky.click({window: await byTitle("LCU GTK4 Button"), x: 5000, y: 5000}); nodeRepl.write("no error"); }'
                              ' catch (error) { nodeRepl.write("error: " + error.message); }')
        assert outside.startswith('error: ') and 'outside' in outside, outside
        assert not (support.output / 'Gtk4-click').exists()
        assert session.focused_id() == entry_window['id'], 'a refused click must not change focus'

        # A window that is not listed keeps the engine's own error; nothing is sent to the desktop.
        error = session.run('try { await sky.press_key({window: {app: "x11:1", id: 1, title: "gone", x: 0, y: 0, width: 5, height: 5, focused: false, modal: false, window_type: "normal"}, key: "q"}); nodeRepl.write("no error"); } catch (error) { nodeRepl.write("error: " + error.message); }')
        assert error.startswith('error: '), error
        assert session.focused_id() == entry_window['id']
    finally:
        session.close()

    # Opt-out: the original engine behavior returns, including the focus-free, ineffective delivery.
    off = support.Session(command, env={**os.environ, 'LCU_LINUX_INPUT_TRANSLATION': 'off'})
    try:
        off.activate('LCU GTK4 Entry')
        before = support.read('Gtk4Surface-entry.txt')
        off.run('await sky.press_key({window: await byTitle("LCU GTK4 Surface"), key: "z"});'
                'await sky.click({window: await byTitle("LCU GTK4 Button"), x: 150, y: 80});')
        time.sleep(1)
        assert support.read('Gtk4Surface-entry.txt') == before, 'translation was not disabled'
        assert not (support.output / 'Gtk4-click').exists(), 'translation was not disabled'
        assert off.focused_id() == entry_window['id'], 'the original path must not change focus'
    finally:
        off.close()
        support.stop_fixtures()


try:
    run('await cua.getState();')
    for _ in range(50):
        windows = json.loads(run('nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));'))
        found = {w['title']: w for w in windows if w.get('title') in ('LCU GTK4 Entry', 'LCU GTK4 Button')}
        if len(found) == 2:
            break
        time.sleep(0.2)
    assert len(found) == 2, windows
    entry, button = found['LCU GTK4 Entry'], found['LCU GTK4 Button']
    run('var {sky} = await import("@oai/sky"); globalThis.windows = await sky.list_windows();'
        'globalThis.pick = title => windows.find(w => w.title === title);')

    # Informational: `typeText` is not one input path across app versions. ChatGPT 26.928 inserts through
    # AT-SPI, which GTK 4 accepts (it may report a caret error afterwards); 26.915 inserted nothing here.
    run(f'let app = await cua.getApp({{windowId:{entry["id"]}}}); '
        'try { await app.typeText("alpha"); } catch (error) { nodeRepl.write("typeText: " + error.message); }')
    inserted = settle(lambda: entry_text() == 'alpha')
    print(f'INFO: app.typeText on a GTK 4 entry: {"inserted" if inserted else "inserted nothing"}', flush=True)

    # Desktop-level keys reach GTK 4: focus the window, then press with no `window`.
    run('await sky.activate_window({window: pick("LCU GTK4 Entry")});'
        'await sky.press_key({key: "ctrl+a"}); await sky.press_key({key: "BackSpace"});')
    assert settle(lambda: entry_text() == ''), entry_text()
    run('await sky.type_text({text: "gamma"});')
    assert settle(lambda: entry_text() == 'gamma'), entry_text()
    run('await sky.press_key({key: "ctrl+a"}); await sky.press_key({key: "BackSpace"});')
    assert settle(lambda: entry_text() == ''), entry_text()
    run('await sky.type_text({text: "beta"}); await sky.press_key({key: "Return"});')
    assert settle(lambda: entry_text() == 'beta' and (output / 'Gtk4-activated').exists()), entry_text()

    # A desktop-level coordinate click reaches GTK 4 (window geometry from the original list).
    run('await sky.activate_window({window: pick("LCU GTK4 Button")});')
    click_x, click_y = button['x'] + button['width'] // 2, button['y'] + button['height'] // 2
    run(f'await sky.click({{x: {click_x}, y: {click_y}}});')
    assert settle(lambda: (output / 'Gtk4-click').exists()), 'desktop-level click did not reach GTK 4'
    (output / 'Gtk4-click').unlink()

    # Window-targeted input (what app.pressKey/app.click/app.scroll/app.drag send) reaches GTK 4 through
    # LCU's translation to the engine's desktop-level calls. The windows below observe what arrived.
    window_targeted(command)
    print('PASS: GTK 4 desktop-level text, keys, Return and coordinate click', flush=True)
finally:
    client.close()
