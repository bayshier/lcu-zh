#!/usr/bin/env python3
"""Development check: can LCU extract the native-pipe host from an installed app.asar?

Reads a user-supplied app.asar (any platform's ChatGPT build), reports the
structural result, writes the extraction to a temporary directory, loads the
generated module in plain Node with Electron blocked, and calls the factory
(listen, closeActiveTurn on an unknown turn, dispose). It never writes into the
app and removes its temporary files; do not commit anything it extracts.
"""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

SOURCE = Path(__file__).resolve().parents[1]
# LCU's own Node module plans and writes the extraction; this script only reports and probes it.
EXTRACT = r'''
const [module, archive, node, destination] = process.argv.slice(1);
const { planOriginalAsar, writeOriginalHost } = await import(module);
let plan, entry;
try {
  plan = planOriginalAsar(archive, { node });
  entry = writeOriginalHost(plan, destination);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(JSON.stringify({ main: plan.main, factory: plan.factory, module: plan.module.length,
  uncarried: plan.uncarried, contents: Object.keys(plan.contents).sort(), entry }));
'''

PROBE = r'''
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request.startsWith('electron/')) throw new Error('blocked ' + request);
  return resolve.call(this, request, ...rest);
};
const factory = require(process.argv[2]);
(async () => {
  const host = await factory({codexCliPath: 'codex', nativePipeDirectory: process.argv[3],
    windowsHelperPath: 'helper.exe', windowsHelperTransportModulePath: 'transport.js'});
  const closed = await host.closeActiveTurn({sessionId: 'unknown', turnId: 'unknown'});
  await host.dispose();
  console.log(JSON.stringify({keys: Object.keys(host).sort(), closeActiveTurnUnknown: closed}));
})().catch(error => { console.error(error); process.exit(1); });
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('asar', type=Path, help='path to the installed app.asar (read only)')
    parser.add_argument('--node', type=Path, default=Path(shutil.which('node') or 'node'),
                        help='Node executable that runs the analyzer and the load check')
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix='lcu-host-check-') as scratch:
        root = Path(scratch)
        result = subprocess.run([str(args.node), '--input-type=module', '-e', EXTRACT,
                                 (SOURCE / 'lcu/windows_host.mjs').as_uri(), str(args.asar), str(args.node),
                                 str(root / 'host')], capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise ValueError(result.stderr.strip() or 'extraction failed')
        plan = json.loads(result.stdout)
        print(f"main bundle: {plan['main']}")
        print(f"factory: {plan['factory']} ({plan['module']} generated characters)")
        print(f"top-level calls on imported modules not carried: {plan['uncarried']}")
        print(f"chunk files: {len(plan['contents'])}")
        for name in plan['contents']:
            print(f'  {name}')
        entry = Path(plan['entry'])
        generated = entry.parent / plan['main'].rsplit('/', 1)[0] / 'lcu-original-pipe-host.cjs'
        probe = root / 'probe.cjs'
        probe.write_text(PROBE)
        pipe = ('\\\\.\\pipe\\lcu-host-check-' + str(uuid.uuid4()) if sys.platform == 'win32'
                else str(root / 'pipe'))
        result = subprocess.run([str(args.node), str(probe), str(generated), pipe],
                                capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            print(result.stderr.strip(), file=sys.stderr)
            raise SystemExit('The generated module did not load and run in plain Node.')
        print('plain Node load with Electron blocked: ' + json.dumps(json.loads(result.stdout)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise SystemExit(f'check_windows_host_layout: {exc}')
