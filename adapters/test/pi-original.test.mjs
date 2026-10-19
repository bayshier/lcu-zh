import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv } from './isolated-env.mjs';

const extension = fileURLToPath(new URL('../pi/index.ts', import.meta.url));

function chunk(model, delta, finishReason = null) {
  return { id: 'original-local-script', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

test('installed Pi de-duplicates user and project LCU packages and uses project command',
  { skip: !process.env.PI_BIN || !process.env.LCU_REAL_COMMAND, timeout: 45_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lcu-pi-original-'));
    const agentDir = join(directory, 'agent');
    mkdirSync(agentDir);
    const project = join(directory, 'project');
    mkdirSync(project);
    const packageDir = join(directory, '.local/share/lcu/pi');
    mkdirSync(packageDir, { recursive: true });
    const installedExtension = join(packageDir, 'extension.mjs');
    writeFileSync(join(packageDir, 'commands.json'), JSON.stringify({
      user: ['/invalid/user/command'], projects: { [realpathSync(project)]: JSON.parse(process.env.LCU_REAL_COMMAND) },
    }));
    mkdirSync(join(project, '.pi'));
    // A repository file cannot replace the account-owned command selection.
    writeFileSync(join(project, '.pi/lcu-command.json'), '["/invalid/repository/command"]\n');
    writeFileSync(installedExtension, `import lcu from ${JSON.stringify(pathToFileURL(extension).href)};\n` +
      'import {readFileSync, realpathSync} from "node:fs";\n' +
      `const config = JSON.parse(readFileSync(${JSON.stringify(join(packageDir, 'commands.json'))}, "utf8"));\n` +
      'export default pi => lcu(pi, {command: config.projects?.[realpathSync(process.cwd())] ?? config.user});\n');
    const installEnv = isolatedEnv(directory, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' });
    for (const [cwd, extra] of [[directory, []], [project, ['-l']]]) {
      const installed = spawnSync(process.env.PI_BIN, ['install', ...extra, installedExtension],
        { cwd, env: installEnv, encoding: 'utf8' });
      assert.equal(installed.status, 0, installed.stderr);
    }
    const requests = [];
    const server = createServer(async (request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.push(body);
      const index = requests.length;
      const code = index === 1
        ? 'var lcuPiSmoke = 6 * 7; nodeRepl.write(lcuPiSmoke);'
        : 'nodeRepl.write(lcuPiSmoke + 1);';
      const delta = index <= 2
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function',
          function: { name: 'js', arguments: JSON.stringify({ code }) } }] }
        : { role: 'assistant', content: 'Done.' };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify(chunk(body.model, delta))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk(body.model, {}, index <= 2 ? 'tool_calls' : 'stop'))}\n\n`);
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
      const child = spawn(process.env.PI_BIN, ['-p', '--mode', 'json', '--no-session',
        '--no-builtin-tools',
        '--no-skills', '--no-context-files', '--provider', 'fixture', '--model', 'scripted',
        'Call original js twice with the supplied pure JavaScript arithmetic, then finish.'],
      { cwd: project, env: isolatedEnv(directory, { PI_CODING_AGENT_DIR: agentDir,
        NODE_REPL_DISABLE_ANALYTICS: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', part => { stdout += part; });
      child.stderr.on('data', part => { stderr += part; });
      let timer;
      const exit = await Promise.race([
        new Promise(resolve => child.on('exit', code => resolve(code))),
        new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Pi original fixture timed out')); }, 35_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(exit, 0, stderr.slice(-1800));
      assert.equal(requests.length, 3, stdout.slice(-1800));
      assert.ok(requests[0].tools, JSON.stringify(requests[0]).slice(0, 1500));
      const js = requests[0].tools.find(tool => tool.function.name === 'js');
      assert.ok(js);
      assert.match(js.function.description, /Control native apps or browsers/);
      assert.ok(requests[0].tools.some(tool => tool.function.name === 'js_reset'));
      assert.equal(requests[0].tools.filter(tool => tool.function.name === 'js').length, 1);
      assert.ok(!requests[0].tools.some(tool => tool.function.name === 'turn_ended'));
      assert.match(JSON.stringify(requests[0].messages), /UI automation through cua_repl/);
      assert.equal((JSON.stringify(requests[0].messages).match(/UI automation through cua_repl/g) ?? []).length, 1);
      assert.match(JSON.stringify(requests[1].messages), /42/);
      assert.match(JSON.stringify(requests[2].messages), /43/);
      const events = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
      assert.equal(events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'js').length, 2);
    } finally {
      await new Promise(resolve => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  });
