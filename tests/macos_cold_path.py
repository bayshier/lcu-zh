#!/usr/bin/env python3
"""No-GUI probe of the original macOS trusted LaunchServices bridge.

This deliberately uses a nonexistent app path. It proves that the bridge is
available and validates the path, not that the signed helper starts cold.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import tempfile

from macos_session import isolated_env
from mcp_client import Client


SERVICE = '''export async function handleRpc({applicationPath}) {
  const result = {
    launch: typeof nodeRepl.launchServices?.openApplication,
    nativePipe: typeof nodeRepl.nativePipe?.createConnection
  };
  try {
    await nodeRepl.launchServices.openApplication({applicationPath});
    result.outcome = {name: 'UnexpectedSuccess'};
  } catch (error) {
    result.outcome = {name: error.name, message: error.message};
  }
  return result;
}
'''


def run(command: list[str], env: dict[str, str], missing: Path) -> dict:
    client = Client(command, env=env)
    try:
        response = client.js('nodeRepl.write(JSON.stringify(await nodeRepl.rpc('
                             '"lcu-cold-probe", {applicationPath:' + json.dumps(str(missing)) + '})));')
        result = json.loads(next(block['text'] for block in reversed(response['content'])
                                 if block['type'] == 'text'))
        assert result['launch'] == 'function', result
        assert result['nativePipe'] == 'function', result
        assert result['outcome'] == {'name': 'Error',
                                    'message': 'LaunchServices application path does not exist'}, result
        return result
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--app', type=Path, default=Path('/Applications/ChatGPT.app'))
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('This probe requires macOS')
    release = args.release.resolve(strict=True)
    app = args.app.resolve(strict=True)
    runtime = app / 'Contents/Resources/cua_node'
    commands = {
        'upstream': [str(runtime / 'bin/node'),
                     str(runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')],
        'lcu': [str(release / 'bin/lcu')],
    }
    with tempfile.TemporaryDirectory(prefix='lcu-macos-cold-probe-') as temporary:
        root = Path(temporary)
        service = root / 'probe.mjs'
        service.write_text(SERVICE)
        missing = root / 'definitely-missing-CUAService.app'
        assert not missing.exists()
        results = {}
        for side, command in commands.items():
            home = root / side
            env = isolated_env(home, app)
            env['NODE_REPL_TRUSTED_SERVICES'] = json.dumps({
                'sky': '@oai/sky/service', 'lcu-cold-probe': str(service)})
            env['NODE_REPL_TRUSTED_CODE_PATHS'] += os.pathsep + str(root)
            results[side] = run(command, env, missing)
    assert results['upstream'] == results['lcu'], results
    print(json.dumps({'result': 'passed', 'upstream_equals_lcu': True,
                      'cold_helper_started': False, 'probe': results['lcu']}, indent=2))


if __name__ == '__main__':
    main()
