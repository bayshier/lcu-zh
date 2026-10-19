"""Exercise the installed MCP command, with independent GTK and file oracles."""
import json
import os
from pathlib import Path
import re
import sys
import time
from mcp_client import Client, text

command = sys.argv[1:] or ['/opt/lcu/current/bin/lcu']
resources = Path('/opt/lcu/current/app/resources')
modules = resources / 'cua_node/lib/node_modules'
repl_instructions = modules / '@oai/cua-repl/instructions'
cua_docs = modules / '@oai/cua/docs'
core = (cua_docs / 'tinysky-alt-core-cua-repl.md').read_text()
policy = (cua_docs / 'tinysky-alt-confirmations.md').read_text()
client = Client(command)
try:
    tools = client.call('tools/list', {})['tools']
    names = {item['name'] for item in tools}
    assert {'js', 'js_reset', 'js_add_node_module_dir', 'turn_ended'} <= names
    js_tool = next(item for item in tools if item['name'] == 'js')
    description = js_tool['description']
    expected_description = '\n\n'.join((repl_instructions / name).read_text().rstrip()
        for name in ('linux/description.md', 'browser-disabled.md', 'linux/computer.md', 'linux/output.md'))
    assert description == expected_description, 'First-call instructions were changed or truncated'
    assert client.initialization['instructions'] == (repl_instructions / 'server.md').read_text().rstrip()
    assert js_tool['inputSchema']['properties']['code']['description'] == (repl_instructions / 'code.md').read_text().rstrip()
    reset_tool = next(item for item in tools if item['name'] == 'js_reset')
    assert reset_tool['description'] == (repl_instructions / 'reset.md').read_text().rstrip()
    initial = client.js('await cua.getState();')
    assert core in text(initial), 'First-use API instructions were changed or truncated'
    assert policy in text(initial), 'Default confirmation policy was changed or truncated'
    surfaces = json.loads(text(client.js('nodeRepl.write(JSON.stringify({computer:typeof cua.getApp,browser:typeof cua.createBrowserTab}));')))
    assert surfaces == {'computer': 'function', 'browser': 'undefined'}, surfaces
    # The guide reaches the model through the tool result above, as in official Codex; no skill.
    assert not (Path.home() / '.local/share/lcu/skills').exists()
    for attempt in range(30):
        response = client.js('nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));')
        windows = json.loads(text(response))
        targets = {w['title']: w for w in windows if w.get('title') in ('LCU Target', 'LCU Other', 'LCU Fallback')}
        if len(targets) == 3:
            break
        time.sleep(0.1)
    assert len(targets) == 3, windows
    # The unchanged upstream public import must execute, not merely resolve.
    low_level = client.js(f'var {{sky}} = await import("@oai/sky"); var window = (await sky.list_windows()).find(w => w.id === {targets["LCU Target"]["id"]}); var rawState = await sky.get_window_state({{window, include_screenshot:false}}); nodeRepl.write(rawState.ax_tree.to_string());')
    assert 'Draft text' in text(low_level)
    full_image = client.js('await nodeRepl.emitImage((await sky.get_screenshot())[0].data_url);')
    assert any(item['type'] == 'image' for item in full_image['content'])
    state = text(client.js(f'let app = await cua.getApp({{windowId:{targets["LCU Target"]["id"]}}});'))
    assert 'at_spi' in state, state
    print('Initial accessibility:', state, flush=True)
    # Read actual IDs from the observed accessibility text, not implementation state.
    def element(state, label):
        line = next(line for line in state.splitlines() if label in line)
        match = re.search(r'\[(\d+)\]', line) or re.search(r'^\s*(\d+)\b', line)
        assert match, line
        return match.group(1)
    entry = element(state, 'Draft text')
    expected = 'Café 日本語 🐧'
    state = text(client.js(f'await app.click({json.dumps(entry)}); await app.typeText({json.dumps(expected)}); await app.getAXState();'))
    assert expected in state, state
    button = element(state, 'Save draft')
    saved = text(client.js(f'await app.click({json.dumps(button)}); await app.getAXState();'))
    assert 'Saved: ' + expected in saved, saved
    assert Path(os.environ['LCU_TEST_OUTPUT'], 'Target.txt').read_text() == expected
    # Native key combinations, text paste, and an advertised secondary action.
    entry = element(saved, 'Draft text')
    expected = 'Second pass Δ'
    state = text(client.js(f'await app.click({json.dumps(entry)}); await app.pressKey("ctrl+a"); await app.paste({json.dumps(expected)}); await app.getAXState();'))
    assert expected in state
    entry, button = element(state, 'Draft text'), element(state, 'Save draft')
    client.js(f'await app.performSecondaryAction({json.dumps(entry)}, "activate"); await app.getAXState();')
    assert Path(os.environ['LCU_TEST_OUTPUT'], 'Target-activated').read_text() == 'yes'
    client.js(f'await app.click({json.dumps(button)}); await app.getAXState();')
    assert Path(os.environ['LCU_TEST_OUTPUT'], 'Target.txt').read_text() == expected
    other = text(client.js(f'let other = await cua.getApp({{windowId:{targets["LCU Other"]["id"]}}});'))
    assert 'untouched' in other and expected not in other
    image = client.js('await app.getScreenshot();')
    images = [c for c in image['content'] if c['type'] == 'image']
    assert len(images) == 1 and images[0]['mimeType'] == 'image/jpeg'
    assert len(images[0]['data']) > 1000
    fallback = text(client.js(f'let fallback = await cua.getApp({{windowId:{targets["LCU Fallback"]["id"]}}});'))
    assert 'Accessibility source: x11' in fallback, fallback
    client.js('await fallback.getScreenshot();')
    client.js('await fallback.click([40,40]); await fallback.getAXState();')
    assert Path(os.environ['LCU_TEST_OUTPUT'], 'fallback-click.txt').read_text() == '40,40'
    client.js('await app.setValue(1, "bad");', error=True)
    client.js('await app.selectText(1, "bad");', error=True)
    client.js('await app.scroll([50,50], "down", 2);', error=True)
    client.js('await cua.getApp("LCU Target");', error=True)
    client.js('await app.click("not-an-element");', error=True)
    # A failed input must not silently write to another window or change the file.
    assert Path(os.environ['LCU_TEST_OUTPUT'], 'Target.txt').read_text() == expected
    client.js('let persisted = 41;')
    assert text(client.js('nodeRepl.write(persisted + 1);')) == '42'
    client.call('tools/call', {'name': 'js_reset', 'arguments': {}})
    reset = client.js('await cua.listWindows({emit:false});')
    assert core in text(reset) and policy in text(reset), 'Reset lost full documentation'
    assert text(client.js('nodeRepl.write(typeof persisted);')) == 'undefined'
    replay = client.js('await cua.rewriteDocumentation();')
    assert core in text(replay) and policy in text(replay), 'Compaction replay lost full documentation'
    # Timeout and recovery use the original REPL behavior.
    client.js('await new Promise(() => {});', error=True, timeout_ms=100)
    client.js('await cua.listWindows();')
    assert text(client.js('nodeRepl.write(6 * 7);')) == '42'
    print('PASS: MCP discovery, Linux docs, AT-SPI, Unicode, keys, paste, secondary action, window isolation, save oracle, X11 fallback coordinates, JPEG, errors, persistence, reset, timeout recovery')
finally:
    client.close()
