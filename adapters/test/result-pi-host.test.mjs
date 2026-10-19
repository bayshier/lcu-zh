import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isolatedEnv } from './isolated-env.mjs';

const fixture = fileURLToPath(new URL('./result-fixture.mjs', import.meta.url));
const extension = fileURLToPath(new URL('../pi/index.ts', import.meta.url));
const adapterPackage = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;
const CASES = ['text', 'image', 'audio', 'error'];

function chunk(model, delta, finishReason = null) {
  return { id: 'lcu-result-fixture', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function dataUrls(value, found = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)) found.push(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) dataUrls(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) dataUrls(item, found);
  }
  return found;
}

function toolMessages(request) {
  return request.messages.filter(message => message.role === 'tool');
}

function textContents(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textContents);
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return [value.text];
    return Object.values(value).flatMap(textContents);
  }
  return [];
}

async function run(caseName, evidenceRoot) {
  const directory = join(evidenceRoot, caseName);
  const home = join(directory, 'home');
  const agentDir = join(home, '.pi');
  const project = join(directory, 'project');
  const resultLog = join(directory, 'mcp-result.jsonl');
  const hostLog = join(directory, 'host-events.jsonl');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });

  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.push(body);
      writeFileSync(join(directory, 'provider-requests.json'), JSON.stringify(requests, null, 2));
      const callNumber = requests.length;
      const delta = callNumber === 1
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `result-${caseName}`, type: 'function',
          function: { name: 'js', arguments: JSON.stringify({ code: `lcu-result:${caseName}` }) } }] }
        : { role: 'assistant', content: `Fixture ${caseName} complete.` };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify(chunk(body.model, delta))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk(body.model, {}, callNumber === 1 ? 'tool_calls' : 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500).end('fixture provider failed');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-fixture-only',
    models: [{ id: 'scripted', name: 'Scripted fixture', reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 512 }],
  } } }));

  try {
    const env = isolatedEnv(home, {
      PI_CODING_AGENT_DIR: agentDir,
      LCU_MCP_COMMAND: JSON.stringify([node, fixture]),
      LCU_RESULT_LOG: resultLog,
      NODE_REPL_DISABLE_ANALYTICS: '1',
    });
    const packageInstall = process.env.PI_INSTALL_PACKAGE === '1';
    if (packageInstall) {
      const installed = spawnSync(process.env.PI_BIN, ['install', adapterPackage], {
        cwd: project, env, encoding: 'utf8', timeout: 20_000,
      });
      assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
      const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
      assert.ok((settings.packages ?? []).some(source => resolve(agentDir, source) === resolve(adapterPackage)),
        JSON.stringify(settings));
    }
    const extensionArgs = packageInstall ? [] : ['--no-extensions', '-e', extension];
    const args = ['-p', '--mode', 'json', '--no-session', ...extensionArgs,
      '--no-builtin-tools', '--no-skills', '--no-context-files', '--provider', 'fixture', '--model', 'scripted',
      `Call original js once with code lcu-result:${caseName}, then finish.`];
    const child = spawn(process.env.PI_BIN, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    let timeout;
    let exitCode;
    try {
      exitCode = await Promise.race([
        new Promise(resolve => child.on('exit', resolve)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Pi result fixture ${caseName} timed out`));
          }, 35_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    writeFileSync(hostLog, stdout);
    writeFileSync(join(directory, 'stderr.txt'), stderr);
    assert.equal(exitCode, 0, stderr.slice(-2000));
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 2, JSON.stringify(requests.map(request => request.messages?.slice(-3))));

    const mcp = readFileSync(resultLog, 'utf8').trim().split('\n').map(JSON.parse);
    const call = mcp.find(event => event.kind === 'call');
    const original = mcp.find(event => event.kind === 'result')?.result;
    assert.equal(call.name, 'js');
    assert.equal(call.args.code, `lcu-result:${caseName}`);
    assert.equal(typeof call.meta?.['x-codex-turn-metadata']?.session_id, 'string');
    assert.equal(typeof call.meta?.['x-codex-turn-metadata']?.turn_id, 'string');
    assert.ok(original, JSON.stringify(mcp));
    const payload = mcp.find(event => event.kind === 'payload');
    if (caseName === 'image' || caseName === 'audio') {
      assert.ok(payload, JSON.stringify(mcp));
      const originalBytes = Buffer.from(original.content[0].data, 'base64');
      assert.equal(createHash('sha256').update(originalBytes).digest('hex'), payload.sha256);
    }

    const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const execution = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'js');
    assert.ok(execution, stdout.slice(-2000));
    const providerResult = toolMessages(requests[1]);
    assert.equal(providerResult.length, 1, JSON.stringify(requests[1].messages?.slice(-4)));
    return { caseName, directory, original, execution, providerResult: providerResult[0], requests, events };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const evidenceRoot = process.env.LCU_RESULT_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'lcu-result-pi-'));
mkdirSync(evidenceRoot, { recursive: true });

for (const caseName of CASES) {
  const mode = process.env.PI_INSTALL_PACKAGE === '1' ? 'installed package' : 'direct extension';
  test(`installed Pi ${process.env.PI_VERSION ?? '0.73.0'} ${mode} result delivery: ${caseName}`,
    { skip: !process.env.PI_BIN, timeout: 45_000 }, async () => {
      const result = await run(caseName, evidenceRoot);
      const providerText = JSON.stringify(result.providerResult);
      if (caseName === 'text') {
        assert.match(providerText, /LCU_RESULT_FIXTURE_TEXT_20260926/);
        assert.equal(result.execution.isError, false);
      }
      if (caseName === 'image') {
        const base64 = dataUrls(result.requests[1].messages)[0];
        assert.ok(base64, JSON.stringify(result.requests[1].messages).slice(-2000));
        assert.equal(base64, result.original.content[0].data);
        assert.equal(result.execution.isError, false);
      }
      if (caseName === 'audio') {
        const originalAudio = result.original.content[0];
        const referenceText = textContents(result.providerResult.content).find(text =>
          /original MIME type:/i.test(text) && /saved to/i.test(text));
        assert.ok(referenceText, JSON.stringify(result.providerResult));
        const mimeType = referenceText.match(/original MIME type: ([^)]+)/i)?.[1];
        const savedPath = referenceText.match(/saved to\s+(.+?)(?=\s+\(original MIME type:|\s*$)/i)?.[1];
        assert.equal(mimeType, originalAudio.mimeType);
        assert.ok(savedPath && isAbsolute(savedPath), String(savedPath));
        assert.deepEqual(readFileSync(savedPath), Buffer.from(originalAudio.data, 'base64'));
        assert.ok(!providerText.includes(originalAudio.data));
        assert.equal(result.original.content[0].type, 'audio');
        assert.equal(result.execution.isError, false);
      }
      if (caseName === 'error') {
        assert.match(providerText, /LCU_RESULT_FIXTURE_ERROR_20260926/);
        assert.equal(result.original.isError, true);
        assert.equal(result.execution.isError, true);
        assert.equal('is_error' in result.providerResult, false);
        assert.equal('isError' in result.providerResult, false);
      }
    });
}
