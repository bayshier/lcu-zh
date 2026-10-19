"""Call an exported function of an LCU Node module from a Python test driver.

LCU runs on Node; the drivers stay Python. Where a driver needs one of LCU's own helpers (for example the
harness registration that `lcu setup` performs) instead of the whole `lcu` command, it calls the module's
export through `node`, with JSON arguments and a JSON result. This adds no LCU logic to the tests.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess

# The tree whose lcu/*.mjs modules are called: this checkout, or the release named by LCU_MODULE_ROOT.
ROOT = Path(__file__).resolve().parents[1]

_CALL = r'''
const [path, name, args] = process.argv.slice(1);
const { pathToFileURL } = await import('node:url');
const module = await import(pathToFileURL(path).href);
const result = await module[name](...JSON.parse(args));
process.stdout.write('\n@@lcu-result ' + JSON.stringify(result ?? null) + '\n');
'''


def node():
    """The Node that runs LCU here: LCU_NODE, else `node` on PATH (22.15 or later)."""
    found = os.environ.get('LCU_NODE') or shutil.which('node')
    if not found:
        raise SystemExit('Node 22.15 or later is required: set LCU_NODE or put node on PATH.')
    return found


def call(module, function, *arguments, root=None, cwd=None, env=None, timeout=300):
    """`await <module>.<function>(...arguments)` from `<root>/lcu/<module>.mjs`; Path arguments become strings."""
    def plain(value):
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, dict):
            return {key: plain(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [plain(item) for item in value]
        return value
    path = Path(root or os.environ.get('LCU_MODULE_ROOT') or ROOT) / 'lcu' / f'{module}.mjs'
    result = subprocess.run([node(), '--input-type=module', '-e', _CALL, str(path), function,
                             json.dumps(plain(list(arguments)))],
                            cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f'{module}.{function} failed ({result.returncode}): {result.stderr.strip()[-2000:]}')
    for line in reversed(result.stdout.splitlines()):
        if line.startswith('@@lcu-result '):
            return json.loads(line[len('@@lcu-result '):])
    raise RuntimeError(f'{module}.{function} returned no result: {result.stdout[-2000:]}')


def codex_cli(resources, root=None):
    """The app's original Codex CLI, as LCU's app_layout selects it from the resource directory."""
    return Path(call('app_layout', 'locateCodexTools', resources, root=root)['cli'])
