import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piExtension from '../pi/index.ts';

const fixture = fileURLToPath(new URL('./omp-mcp-fixture.mjs', import.meta.url));

test('OMP host surface preserves prompt sections and runs dynamically registered LCU tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-omp-'));
  const log = join(directory, 'mcp.jsonl');
  const oldCommand = process.env.LCU_MCP_COMMAND;
  const oldLog = process.env.LCU_FIXTURE_LOG;
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;

  const handlers = new Map();
  const tools = new Map();
  const registrations = [];
  const omp = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); registrations.push(tool.name); },
    registerCommand() {},
  };
  const ctx = { sessionManager: { getSessionId: () => 'omp-fixture-session' },
    model: { id: 'omp-fixture-model' }, hasUI: false };

  try {
    // OMP's ExtensionAPI uses the same registration and callback surface as Pi.
    await piExtension(omp, { connectOnLoad: true, ompEssentialTools: true });
    const sections = ['OMP base rules', 'OMP project context'];
    const prompt = await handlers.get('before_agent_start')({ systemPrompt: sections }, ctx);
    assert.deepEqual(prompt.systemPrompt.slice(0, 2), sections);
    assert.equal(prompt.systemPrompt.length, 3);
    assert.match(prompt.systemPrompt[2], /Original CUA initialization guide/);
    assert.deepEqual(registrations, ['js', 'js_reset'],
      'OMP must register LCU tools before its bounded before_agent_start hook runs');
    assert.ok([...tools.values()].every(tool => tool.loadMode === 'essential'),
      'OMP must present the core LCU tools to the model instead of deferring them to discovery');

    await handlers.get('agent_start')({}, ctx);
    const result = await tools.get('js').execute('omp-tool-call', { code: 'omp-fixture-result' },
      undefined, undefined, ctx);
    assert.equal(result.content[0].text, 'js');
    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);

    const entries = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(entries.map(entry => entry.name), ['js', 'turn_ended']);
    assert.equal(entries[0].meta['x-codex-turn-metadata'].session_id, 'omp-fixture-session');
    assert.equal(entries[0].meta['x-codex-turn-metadata'].model, 'omp-fixture-model');
    assert.equal(entries[0].meta['x-codex-turn-metadata'].call_id, 'omp-tool-call');
    assert.equal(entries[1].args.hook_event_name, 'Stop');
    assert.equal(entries[1].args.session_id, 'omp-fixture-session');
    await handlers.get('session_shutdown')();
  } finally {
    await handlers.get('session_shutdown')?.();
    if (oldCommand === undefined) delete process.env.LCU_MCP_COMMAND;
    else process.env.LCU_MCP_COMMAND = oldCommand;
    if (oldLog === undefined) delete process.env.LCU_FIXTURE_LOG;
    else process.env.LCU_FIXTURE_LOG = oldLog;
    rmSync(directory, { recursive: true, force: true });
  }
});
