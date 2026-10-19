"""Exercise the original Chrome extension through LCU's installed native host."""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from mcp_client import Client, text

def last_value(result):
    return json.loads(next(item['text'] for item in reversed(result['content']) if item['type'] == 'text'))


def discovery(client):
    observed = []
    for attempt in range(90):
        result = client.js('await cua.listBrowsers();')
        browsers = last_value(result)
        if any(browser['type'] == 'extension' and browser.get('family') == 'chrome' for browser in browsers):
            return browsers
        if not observed or observed[-1] != browsers:
            observed.append(browsers)
        time.sleep(0.5)
    raise AssertionError(f'Original extension/native host did not become discoverable: {observed[-5:]}')


def local_fixture_approval(approvals):
    def handle(method, params):
        if method != 'elicitation/create':
            raise AssertionError(f'Unexpected host request: {method}')
        urls = re.findall(r'https?://[^\s"<>]+', json.dumps(params, sort_keys=True))
        if not urls or any((urlsplit(url).scheme, urlsplit(url).hostname, urlsplit(url).port)
                           != ('http', '127.0.0.1', 8080) for url in urls):
            raise AssertionError(f'Browser approval exceeded the local fixture: {urls}')
        approvals.extend(urls)
        return {'action': 'accept', 'content': {}}
    return handle


PAGE = b'''<!doctype html><title>LCU browser probe</title>
<label for="entry">Message</label><input id="entry">
<button id="save" onclick="fetch('/save?text=' + encodeURIComponent(document.querySelector('#entry').value)).then(() => document.querySelector('#result').textContent = 'Saved')">Save</button>
<output id="result"></output>'''
LOGIN_PAGE = b'''<!doctype html><title>LCU login fixture</title>
<form id="login" onsubmit="event.preventDefault(); fetch('/login', {method: 'POST', body: new URLSearchParams(new FormData(this))}).then(r => r.text()).then(t => document.querySelector('#status').textContent = t)">
<label for="user">User</label><input id="user" name="user">
<label for="pass">Password</label><input id="pass" name="pass" type="password">
<button id="sign-in" type="submit">Sign in</button></form><output id="status"></output>'''


def fixture_server(requests_seen, port=8080):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests_seen.append((self.path, self.headers.get('x-browser-agent')))
            if self.path.startswith('/save?'):
                body = b'ok'
            elif self.path == '/login':
                body = LOGIN_PAGE
            elif self.path == '/protected':
                body = (b'<h1>Private fixture</h1>' if 'fixture_session=yes' in self.headers.get('Cookie', '')
                        else b'<h1>Sign in required</h1>')
            elif self.path == '/slow':
                time.sleep(2)
                body = b'<h1>Slow fixture</h1>'
            else:
                body = PAGE
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            requests_seen.append((self.path, self.headers.get('x-browser-agent')))
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            fields = parse_qs(body.decode())
            valid = self.path == '/login' and fields == {'user': ['fixture'], 'pass': ['fixture']}
            response = b'Signed in' if valid else b'Invalid login'
            self.send_response(200 if valid else 403)
            if valid:
                self.send_header('Set-Cookie', 'fixture_session=yes; HttpOnly; SameSite=Lax')
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def browser_actions(client, requests_seen, session_id):
    client.js('let tab = await cua.createBrowserTab("chrome", "http://127.0.0.1:8080/");')
    state = text(client.js('await tab.getAXState();'))
    field = re.search(r'(?m)^\s*(\d+) text field .*ID: entry$', state)
    button = re.search(r'(?m)^\s*(\d+) button Save, ID: save$', state)
    assert field and button, state
    marker = 'LCU hello Åß🙂'
    client.js(f'await tab.typeText({field.group(1)}, {json.dumps(marker)});')
    client.js(f'await tab.click({button.group(1)});')
    for _ in range(10):
        state = text(client.js('await tab.getAXState();'))
        if 'Saved' in state:
            break
        time.sleep(0.1)
    assert 'Saved' in state, state
    assert any(parse_qs(urlsplit(path).query).get('text') == [marker]
               for path, _header in requests_seen if path.startswith('/save?')), requests_seen
    assert requests_seen and all(header == f'ChatGPT/{session_id}'
                                 for _path, header in requests_seen), requests_seen
    screenshot = client.js('await tab.getScreenshot();')
    assert any(item.get('type') == 'image' and len(item.get('data', '')) > 100
               for item in screenshot['content']), screenshot
    client.js('await tab.goto("http://127.0.0.1:8080/login");')
    state = text(client.js('await tab.getAXState();'))
    user = re.search(r'(?m)^\s*(\d+) text field .*ID: user$', state)
    password = re.search(r'(?m)^\s*(\d+) text field \(settable\) Password$', state)
    sign_in = re.search(r'(?m)^\s*(\d+) button Sign in, ID: sign-in$', state)
    assert user and password and sign_in, state
    client.js(f'await tab.typeText({user.group(1)}, "fixture");')
    client.js(f'await tab.typeText({password.group(1)}, "fixture");')
    client.js(f'await tab.click({sign_in.group(1)});')
    for _ in range(10):
        state = text(client.js('await tab.getAXState();'))
        if 'Signed in' in state:
            break
        time.sleep(0.1)
    assert 'Signed in' in state, state
    client.js('await tab.goto("http://127.0.0.1:8080/protected");')
    state = text(client.js('await tab.getAXState();'))
    assert 'Private fixture' in state, state
    assert any(path == '/protected' and header == f'ChatGPT/{session_id}'
               for path, header in requests_seen), requests_seen
    try:
        client.call('tools/call', {'name': 'js', 'arguments': {
            'code': 'await tab.goto("http://127.0.0.1:8080/slow");'}}, timeout=0.5)
    except AssertionError as error:
        assert 'MCP timeout' in str(error), error
    else:
        raise AssertionError('Slow navigation did not exceed the client deadline')
    time.sleep(2.5)
    assert sum(path == '/slow' for path, _header in requests_seen) == 1, requests_seen
    assert all(header == f'ChatGPT/{session_id}' for _path, header in requests_seen), requests_seen
    client.js('await tab.close();')
    client.js('await tab.getAXState();', error=True)


def denied_site(client_env, release):
    requests_seen = []
    approval_requests = []
    server = fixture_server(requests_seen, 8081)

    def decline(method, params):
        assert method == 'elicitation/create', method
        urls = re.findall(r'https?://[^\s"<>]+', json.dumps(params, sort_keys=True))
        assert urls and all((urlsplit(url).scheme, urlsplit(url).hostname, urlsplit(url).port)
                            == ('http', '127.0.0.1', 8081) for url in urls), urls
        approval_requests.extend(urls)
        return {'action': 'decline'}

    client = Client([str(release / 'bin/lcu'), '--chrome'], env=client_env,
                    request_handler=decline, capabilities={'elicitation': {}})
    try:
        discovery(client)
        client.js('await cua.createBrowserTab("chrome", "http://127.0.0.1:8081/");', error=True)
        assert approval_requests, 'Denied origin did not request site approval'
        assert not requests_seen, f'Denied origin was fetched: {requests_seen}'
    finally:
        client.close()
        server.shutdown()
    return approval_requests


def user_tab_claim(client, browsers):
    chrome_browser = next(browser for browser in browsers
                          if browser['type'] == 'extension' and browser.get('family') == 'chrome')
    client.js(f'let browser = await agent.browsers.get({json.dumps(chrome_browser["id"])});')
    snapshots = last_value(client.js('nodeRepl.write(JSON.stringify(await browser.user.openTabs()));'))
    tab = next(tab for tab in snapshots if tab['url'] == 'about:blank')
    def mention(title):
        query = urlencode({'mention': 'tab-v1', 'source': 'extension',
                           'browserId': chrome_browser['metadata']['extensionInstanceId'],
                           'tabId': tab['providerTabId'], 'title': title, 'url': tab['url']})
        return f'plugin://browser@openai-bundled?{query}'
    client.js(f'await cua.getTab({{mention: {json.dumps(mention("Stale title from another tab"))}}});',
              error=True)
    client.js(f'let userTab = await cua.getTab({{mention: {json.dumps(mention(tab["title"]))}}});')


from differential_baseline import environment as upstream_environment


def chrome(release, original):
    # The setup side (private plugin copy, relay manifest, guards, removed subcommands) is covered by
    # tests/node/browser.test.mjs; this drives the real browser through the installed release.
    base = dict(os.environ)
    base.pop('NODE_REPL_REQUEST_META', None)
    base.pop('CUA_REPL_ENABLED_SURFACES', None)
    base.pop('CUA_REPL_BROWSER_ENV', None)
    base['NODE_REPL_DISABLE_ANALYTICS'] = '1'
    requests_seen = []
    approved_urls = []
    restart_approvals = []
    server = fixture_server(requests_seen)
    default = Client([str(release / 'bin/lcu')], env=base)
    try:
        methods = last_value(default.js('nodeRepl.write(JSON.stringify({'
            'browser: typeof cua.createBrowserTab, native: typeof cua.getApp}));'))
        assert methods == {'browser': 'undefined', 'native': 'function'}, methods
    finally:
        default.close()
    candidate = Client([str(release / 'bin/lcu'), '--chrome'], env=base,
                       request_handler=local_fixture_approval(approved_urls), capabilities={'elicitation': {}})
    try:
        enabled = last_value(candidate.js('nodeRepl.write(JSON.stringify({'
            'browser: typeof cua.createBrowserTab, native: typeof cua.getApp}));'))
        assert enabled == {'browser': 'function', 'native': 'function'}, enabled
        lcu_browsers = discovery(candidate)
        fallback = last_value(candidate.js('nodeRepl.write(JSON.stringify(nodeRepl.requestMeta));'))
        identity = fallback['x-codex-turn-metadata']
        assert set(identity) == {'session_id', 'turn_id'}, identity
        assert identity['session_id'].startswith('lcu-'), identity
        # Discovery should match the untouched service. Its auth decision is
        # tested separately with the original manifest: this Chrome profile
        # currently routes both clients through the installed LCU relay.
        baseline_env = upstream_environment(original, {**base,
            'CUA_REPL_ENABLED_SURFACES': 'browser', 'CUA_REPL_BROWSER_ENV': 'codex-app'})
        baseline_env['NODE_REPL_REQUEST_META'] = json.dumps(fallback)
        baseline = Client([str(original / 'bin/node'),
                          str(original / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')],
                          env=baseline_env, request_handler=local_fixture_approval([]),
                          capabilities={'elicitation': {}})
        try:
            original_browsers = discovery(baseline)
            assert original_browsers == lcu_browsers, (original_browsers, lcu_browsers)
        finally:
            baseline.close()
        user_tab_claim(candidate, lcu_browsers)
        host_metadata = {'x-codex-turn-metadata': {'session_id': 'fixture-host-session', 'turn_id': 'fixture-host-turn'}}
        override = candidate.call('tools/call', {'name': 'js', '_meta': host_metadata,
            'arguments': {'code': 'nodeRepl.write(JSON.stringify(nodeRepl.requestMeta));'}})
        assert last_value(override)['x-codex-turn-metadata'] == host_metadata['x-codex-turn-metadata']
        browser_actions(candidate, requests_seen, identity['session_id'])
        assert approved_urls, 'Browser action did not request scoped site approval'
        denied_urls = denied_site(base, release)
        reset = candidate.call('tools/call', {'name': 'js_reset', 'arguments': {}})
        assert not reset.get('isError'), reset
        candidate.js('await cua.getState();')
        assert any(browser['type'] == 'extension' for browser in discovery(candidate))
        first_requests = list(requests_seen)
        candidate.close()
        candidate = None
        requests_seen.clear()

        restarted = Client([str(release / 'bin/lcu'), '--chrome'], env=base,
                           request_handler=local_fixture_approval(restart_approvals),
                           capabilities={'elicitation': {}})
        try:
            discovery(restarted)
            restarted_meta = last_value(restarted.js('nodeRepl.write(JSON.stringify(nodeRepl.requestMeta));'))
            restarted_session = restarted_meta['x-codex-turn-metadata']['session_id']
            assert restarted_session != identity['session_id']
            browser_actions(restarted, requests_seen, restarted_session)
            assert restart_approvals, 'Restarted service did not request site approval'
        finally:
            restarted.close()
    finally:
        if candidate is not None:
            candidate.close()
        server.shutdown()

    print(json.dumps({'discovery': 'PASS: real original extension and native host',
        'runtime_mode': 'PASS: default native API only; explicit --chrome adds browser API',
        'generic_mcp_connection_identity': 'PASS', 'caller_metadata_override': 'PASS',
        'original_discovery': 'MATCH',
        'lcu_browser_actions': 'PASS: navigation, Unicode, click, save, screenshot, fixture login, close, and agent header',
        'closed_tab_rejected': 'PASS', 'denied_site_not_fetched': 'PASS',
        'stale_user_tab_snapshot_rejected_and_exact_claimed': 'PASS',
        'reset_reconnected': 'PASS', 'mcp_service_restart_actions': 'PASS',
        'slow_navigation_not_replayed_after_client_timeout': 'PASS',
        'approved_urls': approved_urls, 'restart_approvals': restart_approvals,
        'denied_urls': denied_urls,
        'first_agent_header_requests': first_requests,
        'restart_agent_header_requests': requests_seen}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    chrome(*map(Path, sys.argv[1:]))
