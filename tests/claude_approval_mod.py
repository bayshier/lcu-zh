"""Drive a real Claude Code CLI through the lcu-approve mod against a fixture runtime.

No model and no credentials: a scripted local Messages API makes the model call
`mcp__lcu__js` once, the Claude relay (adapters/claude.mjs) forwards it to the
original-runtime fixture, which asks the native-app approval and reports the
answer the relay returned. HOME is a temporary directory.

    python3 tests/claude_approval_mod.py --claude PATH [--scenario NAME ...]

Needs /usr/bin/expect, Node with `npm ci --prefix adapters`, and a Claude Code
build that has mods (2.1.287 or the Claude app's bundled 2.1.286). Not part of
tests/run.sh. Does not touch the real home directory or computer use.
"""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
from lcu_node import call  # noqa: E402

PROMPT = 'Run the approval check.'
KEY = 'sk-ant-api03-' + 'x' * 40

SESSION = {'action': 'accept', 'content': {}, '_meta': {'persist': 'session'}}
ALWAYS = {'action': 'accept', 'content': {}, '_meta': {'persist': 'always'}}
DIALOG = r'Allow.?this.?conversation'


def scenario(pattern=DIALOG, *, mod=True, columns=160, code='approval-native', keys=(), answer=None,
             surface='pane', delay=3, tool='mcp__lcu__js', model_call=None, screen=None, headless=False):
    return dict(pattern=pattern, mod=mod, columns=columns, code=code, keys=list(keys), answer=answer,
                surface=surface, delay=delay, tool=tool, model_call=model_call, screen=screen, headless=headless)


SCENARIOS = {
    'pane-session': scenario(keys='a', answer=SESSION),
    'pane-always': scenario(keys='l', answer=ALWAYS),
    'pane-deny': scenario(keys='d', answer={'action': 'decline'}),
    'pane-dismiss': scenario(keys=['ESC'], answer={'action': 'cancel'}),
    'pane-session-only': scenario(code='approval-native-session-only', keys='a', answer=SESSION),
    # The person takes longer than a hook's 10 s: no hook waits, so the answer still arrives.
    'pane-slow': scenario(keys='a', answer=SESSION, delay=15),
    # The terminal cannot seat an unasked pane below 144 columns: the question dialog is used.
    'ask-narrow': scenario(columns=100, keys=['ENTER'], answer=SESSION, surface='ask'),
    # Without the mod the engine's own form shows, unchanged.
    'no-mod-form': scenario(r'requests.?your.?input', mod=False, columns=100, keys=['ESC'],
                            answer={'action': 'cancel'}, surface='engine'),
    # No person to ask (`claude -p`): the hook steps aside and the host cancels at once, as without the mod.
    'headless': scenario(mod=True, answer={'action': 'cancel'}, surface='engine', headless=True),
    # The model may not call the host-only tools: the mod refuses, and so does the relay without it.
    'model-call-denied': scenario(r'host-only', tool='mcp__lcu__approval_choice',
                                  model_call={'id': 'x', 'choice': 'always'}, surface='engine', screen='host-only'),
    'model-call-no-mod': scenario(r'host-mod', mod=False, tool='mcp__lcu__approval_choice',
                                  model_call={'id': 'x', 'choice': 'always'}, surface='engine', screen='host-mod'),
}


def prepare(base, claude, name, use_mod):
    home = base / 'home'
    project = base / 'project'
    home.mkdir()
    project.mkdir()
    call('claude_visibility', 'install', home)
    settings = home / '.claude/settings.json'
    data = json.loads(settings.read_text())
    data['permissions'].setdefault('allow', []).append('mcp__lcu')
    settings.write_text(json.dumps(data, indent=2))
    if use_mod:
        call('claude_mod', 'install', home, ROOT)
    (home / '.claude.json').write_text(json.dumps({
        'hasCompletedOnboarding': True, 'theme': 'dark', 'numStartups': 5,
        'customApiKeyResponses': {'approved': [KEY[-20:]], 'rejected': []},
        'projects': {str(project): {'hasTrustDialogAccepted': True, 'allowedTools': []}},
    }))
    log = base / 'fixture.jsonl'
    node = shutil.which('node')
    mcp = base / 'mcp.json'
    mcp.write_text(json.dumps({'mcpServers': {'lcu': {
        'command': node,
        'args': [str(ROOT / 'adapters/claude.mjs'), node, str(ROOT / 'adapters/test/claude-fixture.mjs')],
        'env': {'LCU_FIXTURE_LOG': str(log)}}}}))
    return home, project, log, mcp


def run(claude, name, keep):
    spec = SCENARIOS[name]
    base = Path(tempfile.mkdtemp(prefix='lcu-mod-e2e-')).resolve()
    api = None
    ok = False
    try:
        home, project, log, mcp = prepare(base, claude, name, spec['mod'])
        port_file = base / 'port'
        api_log = base / 'api.jsonl'
        api = subprocess.Popen(['node', str(ROOT / 'tests/claude_fake_api.mjs'), str(port_file), str(api_log),
                                spec['tool'], json.dumps(spec['model_call'] or {'code': spec['code']})])
        for _ in range(100):
            if port_file.exists():
                break
            time.sleep(0.05)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('CLAUDE', 'ANTHROPIC'))}
        env.update({'HOME': str(home), 'ANTHROPIC_API_KEY': KEY, 'DISABLE_AUTOUPDATER': '1',
                    'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{port_file.read_text()}',
                    'LCU_E2E_DELAY': str(spec['delay']), 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
                    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '1'})
        debug_file = base / 'debug.log'
        if spec['headless']:
            command = [claude, '-p', PROMPT, '--mcp-config', str(mcp), '--strict-mcp-config',
                       '--debug-file', str(debug_file)]
        else:
            command = ['/usr/bin/expect', str(ROOT / 'tests/claude_approval_mod.exp'), str(base / 'terminal.log'),
                       str(spec['columns']), claude, str(project), PROMPT, spec['pattern'],
                       ' '.join(spec['keys']), str(mcp), '--debug-file', str(debug_file)]
        result = subprocess.run(command, cwd=project, env=env, capture_output=True, text=True, timeout=240)
        records = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        answers = [item['response'] for item in records if item.get('type') == 'elicitation-response']
        debug = debug_file.read_text(errors='replace') if debug_file.exists() else ''
        surface = ('pane' if re.search(r'\(unasked, \d+ columns\): placed', debug) else
                   'ask' if 'AskUserQuestion' in debug else 'engine')
        if spec['model_call']:
            # What the model was told: the tool result Claude Code sent back to the API.
            told = api_log.read_text() if api_log.exists() else ''
            ok = spec['screen'] in told and answers == []
        else:
            ok = answers == [spec['answer']] and surface == spec['surface']
        print(f'  surface={surface} (expected {spec["surface"]})')
        print(f'{"PASS" if ok else "FAIL"} {name}: answers={answers}')
        if not ok or keep:
            print(result.stdout[-1500:])
            print(f'  evidence kept in {base}')
        return ok
    finally:
        if api:
            api.terminate()
        if not keep and ok:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', required=True, help='Claude Code executable with mods')
    parser.add_argument('--scenario', action='append', choices=sorted(SCENARIOS))
    parser.add_argument('--keep', action='store_true')
    arguments = parser.parse_args()
    results = [run(arguments.claude, name, arguments.keep) for name in arguments.scenario or SCENARIOS]
    sys.exit(0 if all(results) else 1)
