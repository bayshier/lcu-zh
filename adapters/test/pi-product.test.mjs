import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnv } from './isolated-env.mjs';

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));
const extension = fileURLToPath(new URL('../pi/index.ts', import.meta.url));

function scriptedChunk(model, delta, finishReason = null) {
  return { id: 'local-script', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

test('installed Pi sends original CUA tools and instructions, keeps one turn through two calls',
  { skip: !process.env.PI_BIN, timeout: 45_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-product-'));
    const agentDir = join(directory, 'agent');
    const skillDir = join(directory, 'lcu-skill');
    const log = join(directory, 'mcp.jsonl');
    mkdirSync(agentDir);
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: lcu-fixture\ndescription: Local CUA test skill.\n---\nRead the original CUA guide before use.\n');
    const requests = [];
    const server = createServer(async (request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const next = requests.length;
      const model = body.model;
      const delta = next <= 2
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${next}`, type: 'function',
          function: { name: 'js', arguments: JSON.stringify({ code: next === 1 ? 'first' : 'second' }) } }] }
        : { role: 'assistant', content: 'Done.' };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify(scriptedChunk(model, delta))}\n\n`);
      response.write(`data: ${JSON.stringify(scriptedChunk(model, {}, next <= 2 ? 'tool_calls' : 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-fixture',
      models: [{ id: 'scripted', name: 'Scripted', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 512 }],
    } } }));
    try {
      const argv = ['-p', '--mode', 'json', '--no-session',
        '--no-extensions', '-e', extension, '--skill', join(skillDir, 'SKILL.md'),
        '--no-context-files', '--provider', 'fixture', '--model', 'scripted',
        'Use the original js tool twice, then finish.'];
      const child = spawn(process.env.PI_BIN, argv, { cwd: directory,
        env: isolatedEnv(directory, { PI_CODING_AGENT_DIR: agentDir,
          LCU_MCP_COMMAND: JSON.stringify([process.execPath, fixture]), LCU_FIXTURE_LOG: log }),
        stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      let timer;
      const exit = await Promise.race([
        new Promise(resolve => child.on('exit', code => resolve(code))),
        new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Pi fixture timed out')); }, 35_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(exit, 0, stderr.slice(-2000));
      assert.equal(requests.length, 3, JSON.stringify(requests.map(r => ({
        tools: r.tools?.map(t => t.function.name),
        messages: r.messages?.slice(-3).map(m => ({ role: m.role, content: m.content, tool_calls: m.tool_calls })),
      }))) + '\n' + stdout.slice(-600));
      assert.ok(requests[0].tools.some(tool => tool.function.name === 'js'));
      assert.ok(requests[0].tools.some(tool => tool.function.name === 'js_reset'));
      assert.ok(!requests[0].tools.some(tool => tool.function.name === 'turn_ended'));
      assert.ok(!requests[0].tools.some(tool => tool.function.name === 'js_add_node_module_dir'));
      assert.equal(requests[0].tools.find(tool => tool.function.name === 'js').function.description,
        'Original JS description.');
      assert.match(JSON.stringify(requests[0].messages), /Original CUA initialization guide/);
      assert.match(JSON.stringify(requests[0].messages), /lcu-fixture/);
      const records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(records.map(record => record.name), ['js', 'js', 'turn_ended']);
      const firstMeta = records[0].meta['x-codex-turn-metadata'];
      assert.equal(records[1].meta['x-codex-turn-metadata'].session_id, firstMeta.session_id);
      assert.equal(records[1].meta['x-codex-turn-metadata'].turn_id, firstMeta.turn_id);
      assert.deepEqual(records[2].args, { hook_event_name: 'Stop',
        session_id: firstMeta.session_id, turn_id: firstMeta.turn_id });
    } finally {
      await new Promise(resolve => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  });
