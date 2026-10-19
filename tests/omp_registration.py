"""Run the generated OMP plugin through OMP's real linker and RPC discovery.

Requires an already installed OMP binary. All HOME, XDG, project and session
files are disposable; this test makes no model or desktop calls.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from lcu_node import call


def isolated_env(root, omp, profile):
    agent = root / 'home/.omp/profiles' / profile / 'agent'
    temp_root = Path('/private/tmp') if os.uname().sysname == 'Darwin' else root / 'tmp'
    temp_root.mkdir(parents=True, exist_ok=True)
    env = {
        'PATH': os.pathsep.join([str(Path(omp).parent), '/usr/bin', '/bin']),
        'HOME': str(root / 'home'),
        'TMPDIR': str(temp_root),
        'XDG_CONFIG_HOME': str(root / 'xdg/config'),
        'XDG_DATA_HOME': str(root / 'xdg/data'),
        'XDG_CACHE_HOME': str(root / 'xdg/cache'),
        'PI_CODING_AGENT_DIR': str(agent),
        'OMP_PROFILE': profile,
        'OPENAI_API_KEY': 'fixture-invalid',
        'LCU_FIXTURE_LOG': str(root / 'mcp.jsonl'),
        'NO_COLOR': '1',
    }
    for name, path in env.items():
        if name.endswith('_HOME') or name == 'PI_CODING_AGENT_DIR':
            if name != 'HOME':
                Path(path).mkdir(parents=True, exist_ok=True)
    Path(env['HOME']).mkdir(parents=True, exist_ok=True)
    agent.mkdir(parents=True, exist_ok=True)
    (agent / 'models.yml').write_text(
        'providers:\n'
        '  openai:\n'
        '    api: openai-completions\n'
        '    baseUrl: http://127.0.0.1:1/v1\n'
        '    apiKey: fixture-invalid\n'
        '    models:\n'
        '      - id: gpt-4o-mini-fixture\n'
        '        contextWindow: 8192\n'
        '        maxTokens: 1024\n'
        '        supportsTools: true\n')
    return env


def commands_from_output(output):
    for line in output.splitlines():
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(frame, dict):
            if frame.get('command') == 'get_available_commands' and isinstance(frame.get('commands'), list):
                return frame['commands']
            if isinstance(frame.get('commands'), list):
                return frame['commands']
            for key in ('result', 'data', 'payload'):
                nested = frame.get(key)
                if isinstance(nested, dict) and isinstance(nested.get('commands'), list):
                    return nested['commands']
    raise AssertionError(f'OMP RPC returned no available-command list: {output[-2000:]}')


def run_scope(root, omp, scope, profile):
    env = isolated_env(root, omp, profile)
    Path(env['LCU_FIXTURE_LOG']).touch()
    project = root / f'project-{profile}'
    project.mkdir()
    (project / '.omp').mkdir()
    release = Path(__file__).resolve().parents[1]
    fixture = release / 'adapters/test/omp-mcp-fixture.mjs'
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is required to run the original MCP fixture')
    try:
        call('harness_setup', 'configureOmp', Path(env['HOME']), [node, str(fixture)], release,
             {'scope': scope, 'project': project if scope == 'project' else None, 'env': env})
    except RuntimeError as exc:
        if scope != 'project' or 'project' not in str(exc).lower():
            raise
        profile_plugins = Path(env['HOME']) / '.omp/profiles' / profile / 'plugins'
        if profile_plugins.exists():
            raise AssertionError('Rejected OMP project setup still wrote into the active profile plugin registry')
        print(f'OMP project/{profile}: safely rejected; upstream plugin link does not honor project scope ({exc}).')
        return None

    plugin_root = Path(env['HOME']) / '.omp/profiles' / profile / 'plugins'
    package_link = plugin_root / 'node_modules/lcu-computer-use'
    if not package_link.is_symlink():
        raise AssertionError(f'OMP {scope}/{profile} plugin link was not created: {package_link}')
    package = package_link.resolve()
    if (package / 'skills').exists():
        raise AssertionError('The linked OMP package must not register a skill, as in official Codex')
    session = root / f'session-{profile}'
    session.mkdir()
    cwd = project if scope == 'project' else root / f'cwd-{profile}'
    cwd.mkdir(exist_ok=True)
    argv = [omp, '--mode', 'rpc', '--no-session', '--no-tools', '--cwd', str(cwd),
            '--session-dir', str(session), '--model', 'openai/gpt-4o-mini-fixture']
    result = subprocess.run(argv, input='{"id":"probe","type":"get_available_commands"}\n',
                            cwd=cwd, env=env, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise AssertionError(f'OMP {scope} RPC exited {result.returncode}: {result.stderr}\n{result.stdout}')
    commands = commands_from_output(result.stdout)
    if any(item.get('name') == 'skill:lcu' for item in commands if isinstance(item, dict)):
        raise AssertionError(f'OMP {scope}/{profile} still discovered an LCU skill: {commands}')
    fixture_entries = [json.loads(line) for line in Path(env['LCU_FIXTURE_LOG']).read_text().splitlines()]
    if fixture_entries:
        raise AssertionError(f'RPC command listing unexpectedly executed LCU tools: {fixture_entries}')
    print(f'OMP {scope}/{profile}: native plugin linked at {package}; no LCU skill registered.')
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--omp', default=shutil.which('omp'),
                        help='path to an installed OMP binary (defaults to PATH lookup)')
    args = parser.parse_args()
    if not args.omp:
        parser.error('an installed OMP binary is required')
    omp = str(Path(args.omp).resolve())
    with tempfile.TemporaryDirectory(prefix='lcu-omp-registration-',
                                     dir=str(Path(tempfile.gettempdir()).resolve())) as temporary:
        root = Path(temporary)
        user_blue = run_scope(root, omp, 'user', 'lcu-blue')
        user_green = run_scope(root, omp, 'user', 'lcu-green')
        if user_blue == user_green:
            raise AssertionError('OMP user profiles resolved to the same generated package')
        project = run_scope(root, omp, 'project', 'lcu-project')
        if project is not None:
            raise AssertionError('OMP project scope unexpectedly succeeded despite upstream link-scope bug')


if __name__ == '__main__':
    main()
