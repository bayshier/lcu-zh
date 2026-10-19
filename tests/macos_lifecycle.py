"""Exercise macOS lifecycle wiring through the original MCP without desktop actions.

The only replacement is a test client executable that records argv. The signed
native helper is never contacted. This proves lifecycle delivery, not cursor
removal. The original Node REPL sandbox and approvals remain enabled.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
from macos_session import isolated_env  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Path('/Applications/ChatGPT.app'))
    args = parser.parse_args()
    app = args.app.resolve(strict=True)
    runtime = app / 'Contents/Resources/cua_node'
    with tempfile.TemporaryDirectory(prefix='lcu-mac-life-', dir='/private/tmp') as directory:
        scratch = Path(directory)
        env = isolated_env(scratch, app)
        env['SKY_CUA_SERVICE_PATH'] = str(runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app')
        log = scratch / 'native-argv.jsonl'
        fake = scratch / 'record-native-command'
        fake.write_text(f'#!{sys.executable}\nimport json,sys\nfrom pathlib import Path\n'
                        f'log = Path({str(log)!r})\n'
                        'previous = log.read_text() if log.exists() else ""\n'
                        'with log.open("a") as output:\n'
                        '    output.write(json.dumps(sys.argv[1:]) + "\\n")\n'
                        'if "turn-Retry" in sys.argv[2] and "turn-Retry" not in previous:\n'
                        '    sys.exit(17)\n')
        fake.chmod(0o700)
        script = scratch / 'probe.mjs'
        # LCU's own lifecycle wiring and lifetime host, as `lcu` sets them up for one MCP connection.
        script.write_text('''
import assert from 'node:assert/strict';
import {createCuaClient} from CLIENT_MODULE;
import {configureMacosLifecycle} from RUNTIME_MODULE;
import {startOriginalHost} from HOST_MODULE;
const env = {...process.env};
configureMacosLifecycle(ROOT, RUNTIME, env);
const host = await startOriginalHost({client: FAKE_CLIENT, env});
env.LCU_MAC_LIFETIME_SOCKET = host.address;
const client = createCuaClient({command: COMMAND, env});
await client.connect();
try {
  for (const event of ['Stop', 'Interrupt']) {
    const identity = {sessionId:'lcu-mac-cleanup-fixture', turnId:`turn-${event}`};
    const result = await client.call('js', {
      code:'nodeRepl.write((await nodeRepl.rpc("sky", {type:"setup"})).target);'
    }, identity);
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(result.content.some(item => item.text?.trim() === 'mac'));
    await client.turnEnded({...identity, event});
  }
  const retry = {sessionId:'lcu-mac-cleanup-fixture', turnId:'turn-Retry'};
  const setup = {code:'nodeRepl.write((await nodeRepl.rpc("sky", {type:"setup"})).target);'};
  assert.ok(!(await client.call('js', setup, retry)).isError);
  await client.turnEnded({...retry, event:'Stop'});
  // The original runtime swallows the failed callback. The next Sky request
  // must retry native cleanup before forwarding the request to original Sky.
  const next = {...retry, turnId:'after-retry'};
  assert.ok(!(await client.call('js', setup, next)).isError);
  assert.ok(!(await client.call('js', setup, next)).isError);
} finally { await client.close(); await host.stop(); }
'''.replace('CLIENT_MODULE', json.dumps((ROOT / 'adapters/client.mjs').as_uri()))
                  .replace('RUNTIME_MODULE', json.dumps((ROOT / 'lcu/runtime.mjs').as_uri()))
                  .replace('HOST_MODULE', json.dumps((ROOT / 'lcu/macos_host.mjs').as_uri()))
                  .replace('FAKE_CLIENT', json.dumps(str(fake)))
                  .replace('ROOT, RUNTIME', json.dumps(str(ROOT)) + ', ' + json.dumps(str(runtime)))
                  .replace('COMMAND', json.dumps([str(runtime / 'bin/node'), str(
                      runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')])) )
        subprocess.run([str(runtime / 'bin/node'), str(script)], env=env,
                       cwd=scratch, check=True, timeout=45)
        records = [json.loads(line) for line in log.read_text().splitlines()]
        assert len(records) == 4, records
        for record, event in zip(records, ('Stop', 'Interrupt', 'Retry', 'Retry')):
            assert record[0] == 'turn-ended', record
            assert json.loads(record[1]) == {
                'type': 'agent-turn-complete', 'thread-id': 'lcu-mac-cleanup-fixture',
                'turn-id': f'turn-{event}'}, record
    print(json.dumps({'result': 'passed', 'native_commands_recorded': 4,
                      'events': ['Stop', 'Interrupt'], 'failed_callback_retried': True,
                      'desktop_actions': 0}))


if __name__ == '__main__':
    main()
