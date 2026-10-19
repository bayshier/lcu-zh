"""Exercise macOS Codex registration under a disposable home only.

Calls LCU's setup configure (lcu/setup.mjs) directly so neither pwd nor a personal account home is
selected. It does not install the Chrome host or start a desktop provider.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lcu_node import call  # noqa: E402


def configure(names, home, command, tools_root, release, *, environ):
    return call('setup', 'configure', names, home, command, tools_root, release, {'environ': environ}, root=release)


def export_bundle(destination, command, release, *, chrome):
    call('setup', 'exportBundle', destination, command, release, {'chrome': chrome}, root=release)


def host_policy(release):
    return call('setup', 'hostPolicy', release, root=release)


def original_hooks(host_root):
    return call('codex_hooks', 'originalHooks', host_root)


def check_mode(release: Path, app: Path, *, chrome: bool) -> None:
    resources = app / 'Contents/Resources'
    modules = resources / 'cua_node/lib/node_modules'
    runtime = release / 'bin/lcu'
    tools_root = release / 'agent-tools'
    with tempfile.TemporaryDirectory(prefix='lcu-macos-setup-', dir='/private/tmp') as temporary:
        home = Path(temporary)
        codex = home / '.codex/config.toml'
        codex.parent.mkdir()
        codex.write_text('# unrelated account settings\nmodel = "fixture-model"\n'
                         '[mcp_servers.unrelated]\ncommand = "fixture-command"\n')
        env = {
            'HOME': str(home), 'CODEX_HOME': str(codex.parent),
            'PATH': os.pathsep.join((str(Path(sys.executable).parent),
                                    str(resources / 'cua_node/bin'), '/usr/bin', '/bin')),
            'TMPDIR': str(home), 'LANG': 'C.UTF-8',
        }
        command = [str(runtime), *(['--chrome'] if chrome else [])]
        failures = configure(['codex'], home, command, tools_root,
                             release, environ=env)
        assert not failures, failures
        config = tomllib.loads(codex.read_text())
        assert config['model'] == 'fixture-model'
        assert config['mcp_servers']['unrelated']['command'] == 'fixture-command'
        registered = config['mcp_servers']['lcu']
        expected_command = [str(tools_root / 'node/bin/node'),
                            str(release / 'adapters/codex.mjs'), str(runtime),
                            *(['--chrome'] if chrome else [])]
        assert registered['command'] == expected_command[0]
        assert registered.get('args', []) == expected_command[1:]
        for key, value in host_policy(release).items():
            assert registered[key] == value, key

        expected_hooks = original_hooks(resources / 'plugins/openai-bundled')
        assert set(expected_hooks) == {'Stop', 'Interrupt', 'SubagentStop'}
        for event, groups in expected_hooks.items():
            actual = config['hooks'][event]
            assert all(group in actual for group in groups), event
        assert config['hooks']['state'], 'Original hooks were not trusted'

        # Like official Codex computer use: no skill and no copied upstream documents.
        assert not (home / '.local/share/lcu/skills').exists()
        assert not [p for p in home.rglob('SKILL.md') if p.parent.name == 'lcu'], 'an LCU skill was registered'

        export = home / 'portable'
        export_bundle(export, command, release, chrome=chrome)
        assert json.loads((export / 'host-contract.json').read_text()) == host_policy(release)
        assert not (export / 'skills').exists()
        exported = b'\n'.join(path.read_bytes() for path in export.rglob('*') if path.is_file())
        assert (modules / '@oai/cua/docs/tinysky-alt-core-cua-repl.md').read_bytes() not in exported
        assert str(home).encode() not in exported
        assert str(runtime).encode() not in exported


def exercise(release: Path, app: Path) -> None:
    check_mode(release, app, chrome=False)
    check_mode(release, app, chrome=True)
    print(json.dumps({'result': 'passed', 'checks': [
        'disposable native and Chrome-opt-in Codex registration', 'unrelated settings preserved',
        'original MCP policy', 'original trusted lifecycle hooks',
        'no skill and no upstream copies', 'portable export without upstream payload'], 'provider_actions': 0}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--app', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('This registration check requires macOS')
    exercise(args.release.resolve(strict=True), args.app.resolve(strict=True))


if __name__ == '__main__':
    main()
