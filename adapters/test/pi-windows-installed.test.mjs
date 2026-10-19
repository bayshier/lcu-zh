import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const required = ['PI_CLI_JS', 'LCU_TEST_PROJECT', 'LCU_TEST_EXTENSION', 'LCU_TEST_WINDOW_TITLE'];
const configured = required.every(name => process.env[name]);

function chunk(model, delta, finishReason = null) {
  return { id: 'lcu-local-script', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function childEnv(agentDir) {
  // Do not pass personal model keys, auth paths, or an LCU_MCP_COMMAND override.
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR',
    'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, PI_CODING_AGENT_DIR: agentDir, NODE_REPL_DISABLE_ANALYTICS: '1' };
}

test('registered Windows Pi extension uses original CUA with a scripted local provider',
  { skip: !configured, timeout: 90_000 }, async () => {
    const project = process.env.LCU_TEST_PROJECT;
    const extension = process.env.LCU_TEST_EXTENSION;
    for (const path of [process.env.PI_CLI_JS, extension]) {
      assert.ok(existsSync(path), `Missing installed test input: ${path}`);
    }
    // Like official Codex computer use, LCU registers no skill.
    assert.ok(!existsSync(join(project, '.pi', 'skills', 'lcu')), 'An LCU skill is still registered');
    const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-windows-'));
    const agentDir = join(directory, 'agent');
    mkdirSync(agentDir);
    const requests = [];
    const expectedTitle = process.env.LCU_TEST_WINDOW_TITLE;
    const code = [
      'await cua.getState();',
      'var lcuPiSmoke = 6 * 7; nodeRepl.write(lcuPiSmoke);',
      'nodeRepl.write(lcuPiSmoke + 1);',
      'var lcuPiWindows = await cua.listWindows({emit:false}); '
        + `var lcuPiTarget = lcuPiWindows.find(w => w.title === ${JSON.stringify(expectedTitle)}); `
        + 'nodeRepl.write(lcuPiTarget ? "LCU_WINDOW_ID=" + lcuPiTarget.id + ";TITLE=" + lcuPiTarget.title : "LCU_WINDOW_MISSING");',
    ];
    const server = createServer(async (request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.push(body);
      const index = requests.length - 1;
      const delta = index < code.length
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function',
          function: { name: 'js', arguments: JSON.stringify({ code: code[index] }) } }] }
        : { role: 'assistant', content: 'Done.' };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify(chunk(body.model, delta))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk(body.model, {}, index < code.length ? 'tool_calls' : 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-fixture',
        models: [{ id: 'scripted', name: 'Scripted', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000,
          maxTokens: 512 }],
      } } }));
      const args = [process.env.PI_CLI_JS, '-p', '--mode', 'json', '--no-session',
        '--no-context-files',
        '--provider', 'fixture', '--model', 'scripted',
        'Use the supplied original CUA tools in the generated Windows desktop fixture.'];
      const child = spawn(process.execPath, args, { cwd: project, env: childEnv(agentDir),
        stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', part => { stdout += part; });
      child.stderr.on('data', part => { stderr += part; });
      let timer;
      const exit = await Promise.race([
        new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }),
        new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('Pi timed out')); }, 75_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(exit, 0, stderr.slice(-1200));
      assert.equal(requests.length, 5, `Pi model rounds: ${requests.length}; stderr: ${stderr.slice(-600)}`);
      const first = requests[0];
      const names = first.tools.map(tool => tool.function.name);
      assert.equal(names.filter(name => name === 'js').length, 1);
      assert.equal(names.filter(name => name === 'js_reset').length, 1);
      assert.ok(!names.includes('turn_ended'));
      assert.ok(!names.includes('js_add_node_module_dir'));
      assert.match(first.tools.find(tool => tool.function.name === 'js').function.description,
        /Control native apps or browsers/);
      const firstMessages = JSON.stringify(first.messages);
      assert.match(firstMessages, /UI automation through cua_repl/);
      assert.match(firstMessages, /Windows desktop windows/);
      assert.match(JSON.stringify(requests[2].messages), /42/);
      assert.match(JSON.stringify(requests[3].messages), /43/);
      const events = stdout.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return {}; }
      });
      const calls = events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'js');
      assert.equal(calls.length, 4);
      assert.ok(calls.every(event => !event.isError), 'An original CUA call failed');
      const finalMessages = JSON.stringify(requests[4].messages);
      assert.match(finalMessages, new RegExp(`LCU_WINDOW_ID=\\d+;TITLE=${expectedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `Original native result omitted the task-owned window ${expectedTitle}`);
      console.log('Pi project-registered Windows extension: original guide, no skill, four CUA calls, native window ID/title verified.');
      console.log('Print-mode output does not independently establish host-only turn_ended dispatch; adapter regression covers that separately.');
    } finally {
      await new Promise(resolve => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  });
