"""Differential tests use real application state, not LCU implementation calls."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import base64
import json
import os
import platform
from pathlib import Path
import re
import subprocess
import sys
import time
import wave
import io

from mcp_client import Client, text


def wait_for(read, valid, description):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        value = read()
        if valid(value):
            return value
        time.sleep(.05)
    raise AssertionError(f'Timed out: {description}; last value={value!r}')


def exercise(command):
    output = Path(os.environ['DIFFERENTIAL_OUTPUT'])
    result = {'native': {}, 'documentation': {}}
    env = dict(os.environ, CUA_REPL_ENABLED_SURFACES=os.environ.get('DIFFERENTIAL_SURFACES','computer'),
               CUA_REPL_BROWSER_ENV='codex-app', BROWSER_USE_AVAILABLE_BACKENDS='chrome,cdp')
    client = Client(command, env=env)
    try:
        result['initialization'] = client.initialization
        result['tools'] = client.call('tools/list', {})['tools']
        client.js('await cua.getState();')
        result['documentation']['default'] = text(client.js('await cua.rewriteDocumentation();'))
        assert 'Computer Use' in result['documentation']['default']
        result['native']['methods'] = json.loads(text(client.js('nodeRepl.write(JSON.stringify(Object.keys(cua.computer).sort()));')))
        def inventory():
            return json.loads(text(client.js('nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));')))
        windows = wait_for(inventory,
            lambda ws: all(any(w.get('title') == title for w in ws) for title in ('Differential Target', 'Differential Other', 'LCU Fallback')),
            'independent fixtures')
        ids = {w['title']: w['id'] for w in windows if w.get('title')}
        # Execute the original standalone skill's public package-root import;
        # this export was absent from the former reduced projection.
        imported = json.loads(text(client.js('var {sky:standaloneSky}=await import("@oai/sky"); nodeRepl.write(JSON.stringify((await standaloneSky.list_windows()).map(w=>w.title).sort()));')))
        assert 'Differential Target' in imported and 'Differential Other' in imported
        imported_images = [v for v in client.js('await nodeRepl.emitImage((await standaloneSky.get_screenshot())[0].data_url);')['content'] if v['type']=='image']
        assert len(imported_images)==1 and imported_images[0]['mimeType']=='image/jpeg'
        result['native']['original_sky_package_import_and_example'] = 'passed'
        state = text(client.js(f'var app=await cua.getApp({{windowId:{ids["Differential Target"]}}}); var sky=cua.computer; var win=(await sky.list_windows()).find(w=>w.id==={ids["Differential Target"]});'))
        assert 'Accessibility source: at_spi' in state
        client.js(f'await sky.activate_window({{window:(await sky.list_windows()).find(w=>w.id==={ids["Differential Other"]})}}); await sky.move({{x:1300,y:850}}); await sky.move_relative({{dx:-20,dy:-20}});')
        def pointer_position():
            values = dict(line.split('=',1) for line in subprocess.check_output(
                ['xdotool','getmouselocation','--shell'], text=True).splitlines())
            return int(values['X']), int(values['Y'])
        pointer_before = pointer_position()
        assert pointer_before == (1280,830), pointer_before
        focus_before = subprocess.check_output(['xdotool','getwindowfocus'], text=True).strip()
        def element(label, state):
            line = next(line for line in state.splitlines() if label in line)
            match = re.search(r'\[(\d+)\]', line) or re.search(r'^\s*(\d+)\b', line)
            assert match, line
            return match.group(1)
        entry = element('Draft text', state)
        expected = 'Café 日本語 🐧'
        state = text(client.js(f'await app.click({entry}); await app.pressKey("ctrl+a"); await app.typeText({json.dumps(expected)}); await app.getAXState();'))
        state = text(client.js(f'await app.click({element("Save draft",state)}); await app.getAXState();'))
        assert (output / 'Target.txt').read_text() == expected
        assert (output / 'Other.txt').read_text() == 'untouched'
        result['native']['typed_unicode'] = expected
        assert subprocess.check_output(['xdotool','getwindowfocus'], text=True).strip() == focus_before
        assert pointer_position() == pointer_before, (pointer_before, pointer_position())
        result['native']['bound_input_focus_pointer_isolation'] = 'passed'
        expected = 'Pasted Δ second pass'
        state = text(client.js(f'await app.click({element("Draft text",state)}); await app.pressKey("ctrl+a"); await app.paste({json.dumps(expected)}); await app.getAXState();'))
        client.js(f'await app.performSecondaryAction({element("Draft text",state)},"activate"); await app.click({element("Save draft",state)}); await app.getAXState();')
        assert (output / 'Target.txt').read_text() == expected
        assert (output / 'Target-activated.txt').read_text() == 'yes'
        result['native']['paste_secondary_action'] = expected
        clipboard = subprocess.check_output(['python3','-c',
            'import gi;gi.require_version("Gtk","3.0");from gi.repository import Gtk,Gdk;print(Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text() or "",end="")'], text=True)
        result['native']['clipboard_after_paste'] = clipboard
        # Scroll and drag coordinates come from the fixture's documented geometry,
        # independently of runtime state. The widget records actual received input.
        client.js('await app.scroll([100,200],"down",{pixels:500}); await app.getAXState();')
        scroll = float((output / 'Target-scroll.txt').read_text())
        assert scroll > 0
        result['native']['scroll_pixels'] = scroll
        for label, code in (
            ('bound_drag', 'await app.drag([100,500],[300,500]); await app.getAXState();'),
            ('desktop_drag_handle', 'var drag=sky.drag_handle(); await drag.start({x:win.x+100,y:win.y+500}); try { await drag.move_to({x:win.x+300,y:win.y+500}); } finally { await drag.end(); }'),
        ):
            pointer = output / 'Target-pointer.jsonl'
            pointer.write_text('')
            client.js(code)
            endpoints = wait_for(lambda: [json.loads(line) for line in pointer.read_text().splitlines() if line],
                                 lambda es: any(e['type'] == 7 for e in es), label)
            endpoints = [e for e in endpoints if e['type'] in (4, 7)]
            assert len(endpoints) == 2 and [e['x'] for e in endpoints] == [100, 300], endpoints
            result['native'][label] = endpoints
        result['native']['query'] = text(client.js('var q=await sky.get_window_state({window:win,query:"Row 0",include_screenshot:false}); nodeRepl.write({source:q.ax_tree_source,tree:q.ax_tree.to_string(),screenshots:q.screenshots.length});'))
        for label, code in [('window_screenshot','await app.getScreenshot();'),
                            ('combined_window_state_screenshot','await app.getAXStateAndScreenshot();'),
                            ('desktop_screenshot','await nodeRepl.emitImage((await sky.get_screenshot())[0].data_url);')]:
            images = [v for v in client.js(code)['content'] if v['type'] == 'image']
            assert len(images) == 1 and images[0]['mimeType'] == 'image/jpeg'
            raw = base64.b64decode(images[0]['data'])
            assert raw[:2] == b'\xff\xd8' and raw[-2:] == b'\xff\xd9' and len(raw) > 1000
            result['native'][label] = 'valid-jpeg'
        # Input into the Xlib fixture has an independent exact-coordinate oracle.
        fallback = text(client.js(f'var fallback=await cua.getApp({{windowId:{ids["LCU Fallback"]}}});'))
        assert 'Accessibility source: x11' in fallback
        client.js('await fallback.click([40,40]); await fallback.getAXState();')
        assert (output / 'fallback-click.txt').read_text() == '40,40'
        result['native']['fallback_click'] = '40,40'
        state = text(client.js('await app.getAXState();'))
        client.js(f'await app.click({element("Open dialog",state)}); await app.getAXState();')
        assert (output / 'dialog-opened.txt').read_text() == 'opened'
        windows = wait_for(inventory, lambda ws: any(w.get('title') == 'Differential Dialog' for w in ws), 'dialog')
        dialog_id = next(w['id'] for w in windows if w.get('title') == 'Differential Dialog')
        dialog = text(client.js(f'var dialog=await cua.getApp({{windowId:{dialog_id}}});'))
        client.js(f'await dialog.click({element("Close dialog",dialog)});')
        wait_for(lambda: (output / 'dialog-closed.txt').exists(), bool, 'dialog closure')
        client.js('await dialog.getAXState();', error=True)
        result['native']['dialog_lifecycle_stale_window'] = 'passed'
        live_before = {name: (output / (name+'-live.txt')).read_text() for name in ('Target','Other')}
        for code in ('await dialog.click([10,10]);', 'await dialog.typeText("stale-input");',
                     'await dialog.paste("stale-paste");', 'await dialog.pressKey("a");'):
            client.js(code, error=True)
        assert {name: (output / (name+'-live.txt')).read_text() for name in live_before} == live_before
        result['native']['closed_window_rejects_input_without_live_mutation'] = 'click, type, paste, key reject; independent live widget contents unchanged'
        # Original desktop-entry discovery and launch, with a file oracle written by
        # the independent launched process. No shell is used by the UI calls.
        apps = json.loads(text(client.js('nodeRepl.write(JSON.stringify(await sky.list_apps()));')))
        launched = next(app for app in apps if app['name'] == 'LCU Differential Launcher')
        client.js(f'await sky.launch_app({{app:{json.dumps(launched["id"])}}});')
        wait_for(lambda: (output / 'launched.txt').exists(), bool, 'desktop entry launch')
        wait_for(inventory, lambda ws: any(w.get('title') == 'Differential Launched' for w in ws), 'launched window')
        result['native']['application_launch'] = 'passed'
        for code in ('await app.setValue(1,"bad");', 'await app.selectText(1,"bad");',
                     'await app.scroll([50,50],"down",2);', 'await app.click("not-an-element");',
                     'await sky.drag({window:win,path:[{x:10,y:10}]});'):
            client.js(code, error=True)
        assert (output / 'Target.txt').read_text() == expected
        assert (output / 'Other.txt').read_text() == 'untouched'
        result['native']['failed_actions_preserve_files'] = 'passed'
        secondary = Client(command, env=env)
        try:
            secondary.js('await cua.listWindows({emit:false});')
            secondary.js(f'var other=await cua.getApp({{windowId:{ids["Differential Other"]}}});')
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(client.js, 'await app.getAXState();')
                second = pool.submit(secondary.js, 'await other.getAXState();')
                a,b = text(first.result()), text(second.result())
            assert expected in a and 'untouched' in b
            b = text(secondary.js(f'await other.click({element("Draft text",b)}); await other.pressKey("ctrl+a"); await other.typeText("Second client isolated"); await other.getAXState();'))
            secondary.js(f'await other.click({element("Save draft",b)}); await other.getAXState();')
            assert (output/'Other.txt').read_text() == 'Second client isolated'
            assert (output/'Target.txt').read_text() == expected
            result['native']['two_client_observation_and_input_scoping'] = 'concurrent observations; sequential input; independent files'
        finally:
            secondary.close()
        client.js('var persisted=41;')
        assert text(client.js('nodeRepl.write(persisted+1);')) == '42'
        client.call('tools/call', {'name':'js_reset','arguments':{}})
        client.js('await cua.listWindows({emit:false});')
        assert text(client.js('nodeRepl.write(typeof persisted);')) == 'undefined'
        result['documentation']['after_reset'] = text(client.js('await cua.rewriteDocumentation();'))
        assert result['documentation']['after_reset'] == result['documentation']['default']
        client.js('await new Promise(()=>{});', error=True, timeout_ms=100)
        client.js('await cua.listWindows();')
        assert text(client.js('nodeRepl.write(6*7);')) == '42'
        result['native']['reset_timeout_recovery'] = 'passed'
    finally:
        client.close()
        (output / 'result.json').write_text(json.dumps(result, indent=2))
    # Separate REPLs prove alternate docs and host policy metadata select the same
    # original instructions. Metadata is passed through MCP, not a global variable.
    alternative_env = dict(env, TINYSKY_ALT_INITIALIZE_DOCS='core-node-repl',
        NODE_REPL_UNTRUSTED_ENV_ALLOWLIST=','.join(filter(None,(env.get('NODE_REPL_UNTRUSTED_ENV_ALLOWLIST'), 'TINYSKY_ALT_INITIALIZE_DOCS'))))
    alternative = Client(command, env=alternative_env)
    try:
        alternate = alternative.js('await cua.listWindows({emit:false});')
        result['documentation']['core-node-repl'] = text(alternate)
        assert 'cua.initialize()' in text(alternate), 'Alternate upstream documentation selector was not preserved'
    finally:
        alternative.close()
    policy_client = Client(command, env=env)
    try:
        policy = 'DIFFERENTIAL_TEST_POLICY: ask before submitting the fixture form.'
        reply = policy_client.call('tools/call', {'name':'js', 'arguments':{'code':'await cua.listWindows({emit:false});'},
            '_meta': {'openai/confirmation_policies':{'computer_use':policy}}})
        assert not reply.get('isError'), reply
        assert policy in text(reply), 'Host confirmation policy metadata was not delivered'
        result['documentation']['policy_override'] = text(reply)
    finally:
        policy_client.close()
    config = output / 'sky-options.json'
    config.write_text(json.dumps({'target':'linux','post_action_sleep_ms':650,'mouse_size_px':12}))
    configured_env = dict(env, CUA_REPL_ENABLED_SURFACES='computer', OAI_SKY_CONFIG_PATH=str(config))
    configured = Client(command, env=configured_env)
    try:
        configured.js('await cua.listWindows({emit:false});')
        # Measure inside the same JS call, immediately after defer(), so process
        # startup and MCP round trips cannot impersonate the configured wait.
        elapsed = float(text(configured.js('await cua.computer.move({x:1280,y:830}); var started=performance.now(); await cua.computer.move({x:1280,y:830}); nodeRepl.write(performance.now()-started);')))
        assert elapsed >= 600, ('Configured 650ms settling delay was not applied', elapsed)
        images = [block for block in configured.js('await nodeRepl.emitImage((await cua.computer.get_screenshot())[0].data_url);')['content'] if block['type']=='image']
        assert len(images)==1 and images[0]['mimeType']=='image/jpeg'
        result['native']['configured_settling_delay_and_cursor_option'] = '650ms option observed; cursor option accepts screenshot'
        (output/'configured-delay-ms.txt').write_text(str(elapsed))
    finally:
        configured.close()
    config.write_text('{malformed')
    invalid_config = Client(command, env=configured_env)
    try:
        failure = invalid_config.js('await cua.computer.list_windows();', error=True)
        assert 'JSON' in text(failure), text(failure)
        config.write_text(json.dumps({'target':'linux','post_action_sleep_ms':0}))
        invalid_config.call('tools/call', {'name':'js_reset','arguments':{}})
        recovered = invalid_config.js('await cua.listWindows();')
        assert 'Differential Target' in text(recovered)
        result['native']['invalid_sky_configuration_reset_recovery'] = 'malformed JSON rejected; corrected configuration works after reset'
    finally:
        invalid_config.close()
    # The override is an instrumented launch seam, not an automation substitute:
    # fail once at the actual native transport boundary, then exec the verified
    # target runtime's original helper unchanged on the next request.
    runtime = Path(os.environ['DIFFERENTIAL_RUNTIME'])
    arch = {'aarch64':'arm64','x86_64':'x64'}[platform.machine()]
    binary = runtime / f'lib/node_modules/@oai/sky/bin/linux/sky_linux_{arch}'
    assert binary.is_file(), binary
    for failure_mode in ('exit', 'invalid-json'):
        events = output / f'native-{failure_mode}-launches.jsonl'
        wrapper = output / f'native-{failure_mode}-wrapper.py'
        wrapper.write_text('#!/usr/bin/python3\nimport json,os,sys\nfrom pathlib import Path\n'
            + f'events=Path({str(events)!r})\nfirst=not events.exists()\n'
            + 'with events.open("a") as stream: stream.write(json.dumps({"pid":os.getpid(),"args":sys.argv[1:]})+"\\n")\n'
            + 'if first:\n sys.stdin.readline()\n'
            + (' sys.exit(23)\n' if failure_mode == 'exit' else ' print("not-json",flush=True)\n sys.stdin.read()\n')
            + f'os.execv({str(binary)!r},[{str(binary)!r},*sys.argv[1:]])\n')
        wrapper.chmod(0o755)
        recovering = Client(command, env=dict(env, OAI_SKY_LINUX_BIN=str(wrapper)))
        try:
            failure = recovering.js('await cua.computer.list_windows();', error=True)
            expected_error = 'exit=23' if failure_mode == 'exit' else 'invalid JSON'
            assert expected_error in text(failure), text(failure)
            recovered = recovering.js('nodeRepl.write(JSON.stringify(await cua.computer.list_windows()));')
            assert 'Differential Target' in text(recovered) and 'Differential Other' in text(recovered)
            launches = [json.loads(line) for line in events.read_text().splitlines()]
            assert len(launches)==2 and launches[0]['pid']!=launches[1]['pid'], launches
            assert all(record['args']==['server'] for record in launches), launches
            assert (output/'Target-live.txt').read_text() == expected
            assert (output/'Other-live.txt').read_text() == 'Second client isolated'
            result['native'][f'native_helper_{failure_mode}_respawn'] = 'original helper starts on second request; desktop remains intact'
        finally:
            recovering.close()
    if os.environ.get('DIFFERENTIAL_AUDIO') == '1':
        audio_client = Client(command, env=dict(env, SKY_ENABLE_AUDIO='1', NODE_REPL_ENABLE_AUDIO='1'))
        try:
            audio_client.js('await cua.listWindows({emit:false});')
            members = text(audio_client.js('nodeRepl.write(Object.keys(cua.computer).sort());'))
            assert 'start_audio_recording' in members and 'stop_audio_recording' in members
            audio_client.js('await cua.computer.start_audio_recording({max_duration_ms:1500});')
            audio_client.js('await cua.computer.start_audio_recording();', error=True)
            audio = json.loads(text(audio_client.js('var audio=await cua.computer.stop_audio_recording(); nodeRepl.write(JSON.stringify({data:audio.data_url,bytes:audio.bytes.length}));')))
            raw = base64.b64decode(audio['data'].split(',',1)[1])
            assert len(raw) == audio['bytes']
            with wave.open(io.BytesIO(raw)) as recorded:
                assert recorded.getnchannels() == 2 and recorded.getframerate() == 24000
                frames = recorded.readframes(recorded.getnframes())
                assert len(frames)>1000 and any(frames), 'No independent sine-wave signal captured'
            delivered = audio_client.js('await nodeRepl.emitAudio(audio.data_url);')
            blocks = [block for block in delivered['content'] if block.get('type') == 'audio']
            assert len(blocks) == 1, delivered
            assert blocks[0]['mimeType'] in ('audio/wav', 'audio/x-wav'), blocks[0]['mimeType']
            assert base64.b64decode(blocks[0]['data']) == raw, 'Agent-facing audio changed recorded bytes'
            audio_client.js('await cua.computer.stop_audio_recording();', error=True)
            result['native']['optional_audio'] = 'stereo-24000Hz-nonzero-wave delivered as MCP audio; duplicate-start and idle-stop rejected'
        finally:
            audio_client.close()
    else:
        result['native']['optional_audio'] = 'NOT TESTED: enable DIFFERENTIAL_AUDIO with local PulseAudio and sine fixture'
    (output / 'result.json').write_text(json.dumps(result, indent=2))


def compare(directory):
    root = Path(directory)
    a = json.loads((root/'upstream/result.json').read_text())
    b = json.loads((root/'lcu/result.json').read_text())
    for key in ('initialization', 'tools', 'documentation', 'native'):
        assert a[key] == b[key], f'Differential mismatch in {key}; inspect {root}/{{upstream,lcu}}/result.json'
    print(f'PASS: upstream and LCU match {len(a["native"])} native cases plus complete MCP schemas and delivered documentation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['exercise', 'compare'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.mode == 'exercise':
        exercise(args.arguments)
    else:
        compare(*args.arguments)
