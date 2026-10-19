"""Bounded original-versus-LCU macOS MCP check without GUI/provider calls.

Run on macOS with an installed compatible signed ChatGPT.app and a prepared
LCU release. Only MCP initialization, pure JavaScript, and reset are exercised.
This does not prove computer-use or browser provider readiness.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lcu_node import codex_cli  # noqa: E402
from mcp_client import Client, text  # noqa: E402


def isolated_env(home: Path, app: Path) -> dict[str, str]:
    resources = app / 'Contents/Resources'
    codex = codex_cli(resources)
    runtime = resources / 'cua_node'
    modules = runtime / 'lib/node_modules'
    plugins = resources / 'plugins'
    codex_home = home / '.codex'
    codex_home.mkdir(parents=True)
    return {
        # Original macOS CUA resolves its installed native socket under the
        # real account HOME. Keep that path intact and isolate only Codex state
        # and scratch output in this test's temporary directory.
        'HOME': str(Path.home()),
        'CODEX_HOME': str(codex_home),
        'PATH': os.pathsep.join((str(Path(sys.executable).parent), str(runtime / 'bin'), '/usr/bin', '/bin')),
        'LANG': 'C.UTF-8',
        'TMPDIR': str(home),
        'CUA_REPL_ENABLED_SURFACES': 'computer',
        'CUA_REPL_BROWSER_ENV': 'codex-app',
        'CUA_REPL_NODE_REPL_PATH': str(runtime / 'bin/node_repl'),
        'NODE_REPL_NODE_PATH': str(runtime / 'bin/node'),
        'NODE_REPL_NODE_MODULE_DIRS': str(modules),
        'NODE_REPL_TRUSTED_CODE_PATHS': os.pathsep.join((str(codex_home), str(modules), str(plugins))),
        'SKY_CUA_SERVICE_PATH': str(modules / '@oai/sky/Codex Computer Use.app'),
        'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS': '1000',
        'NODE_REPL_DISABLE_ANALYTICS': '1',
        'NODE_REPL_REQUEST_META': json.dumps({'x-codex-turn-metadata': {
            'session_id': 'lcu-macos-validation', 'turn_id': 'pure-js-check'}}),
        'CODEX_CLI_PATH': str(codex),
    }


def exercise(command: list[str], env: dict[str, str]) -> dict:
    client = Client(command, env=env)
    try:
        initialization = client.initialization
        tools = client.call('tools/list', {})['tools']
        assert {tool['name'] for tool in tools} >= {'js', 'js_reset'}
        first = text(client.js('nodeRepl.write(6*7);'))
        assert first.endswith('42'), 'Pure JS did not return 42'
        assert 'macOS' in first or 'macOS' in json.dumps(tools), 'macOS guide was not selected'
        persisted = text(client.js('globalThis.lcuPureValue=41; nodeRepl.write(lcuPureValue+1);'))
        assert persisted == '42', persisted
        persistent = text(client.js('nodeRepl.write(lcuPureValue+1);'))
        assert persistent == '42', persistent
        reset = client.call('tools/call', {'name': 'js_reset', 'arguments': {}})
        assert not reset.get('isError'), reset
        after_reset = text(client.js('nodeRepl.write(typeof lcuPureValue);'))
        assert after_reset.endswith('undefined'), after_reset
        return {'initialization': initialization, 'tools': tools, 'first': first,
                'persistent': persistent, 'after_reset': after_reset}
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True,
                        help='Prepared LCU release root with bin/lcu')
    parser.add_argument('--app', type=Path, required=True,
                        help='Installed ChatGPT.app; used in place')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('This comparison requires macOS')
    app = args.app.resolve(strict=True)
    release = args.release.resolve(strict=True)
    runtime = app / 'Contents/Resources/cua_node'
    original = [str(runtime / 'bin/node'),
                str(runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]
    lcu = [str(release / 'bin/lcu')]
    if not Path(original[0]).is_file() or not Path(original[1]).is_file() or not Path(lcu[0]).is_file():
        parser.error('Original runtime or LCU release executable is missing')
    with tempfile.TemporaryDirectory(prefix='lcu-macos-mcp-', dir='/private/tmp') as temporary:
        root = Path(temporary)
        baseline = exercise(original, isolated_env(root / 'original', app))
        adapted = exercise(lcu, isolated_env(root / 'adapted', app))
    for section in ('initialization', 'tools'):
        assert baseline[section] == adapted[section], f'MCP {section} differs'
    for section in ('first', 'persistent', 'after_reset'):
        assert baseline[section] == adapted[section], f'MCP {section} differs'
    print(json.dumps({'result': 'passed', 'platform': 'macOS', 'checks': [
        'MCP initialize', 'tool schemas and descriptions', 'macOS first-use guide',
        'pure JavaScript', 'persistent JavaScript state', 'js_reset'],
        'provider_actions': 0}, indent=2))


if __name__ == '__main__':
    main()
