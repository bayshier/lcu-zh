// Opt-in integration against the installed original Sky JS. Only its native
// pipe endpoint is simulated; no real app, service, socket or clipboard is used.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const app = process.env.LCU_TEST_ORIGINAL_MAC_APP;
const source = app && join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src');
const skip = process.platform !== 'darwin' || !source || !existsSync(join(source, 'service.js'))
  ? 'requires explicit LCU_TEST_ORIGINAL_MAC_APP on macOS' : false;
const endpoint = 'test-only:lcu-unicode-original';
const target = {bundleIdentifier: 'com.example.lcu.owned-fixture', displayName: 'Owned fixture',
  appPath: '/test-only/OwnedFixture.app', risk: 'normal'};

async function fixture(t, {decision = 'allowed', approval = 'accept', failPaste = false} = {}) {
  const codec = await import(pathToFileURL(join(source, 'targets/mac/native-pipe.js')).href);
  const {client} = await import(pathToFileURL(join(source, 'targets/mac/client.js')).href);
  client.transports.clear();
  const requests = [];
  const approvals = [];
  const pipes = [];
  class FakePipe extends EventEmitter {
    write(data) {
      const decoded = codec.decodeMessageFrames(Buffer.from(data));
      assert.equal(decoded.remainingData.length, 0);
      for (const frame of decoded.messages) {
        const message = JSON.parse(frame);
        let result;
        let error;
        if (message.method === 'ping') result = {serverApiVersion: message.params.clientApiVersion};
        else {
          assert.equal(message.method, 'request');
          const request = message.params;
          requests.push(request);
          if (request.requestType === 'ComputerUseIPCAppPolicyRequest') {
            result = {decision, target, allowPersistentApproval: false};
          } else {
            assert.equal(request.requestType, 'ComputerUseIPCAppPerformActionRequest');
            assert.equal(request.request.app, target.appPath);
            if (failPaste && request.request.action.paste) error = {code: -10008, message: 'fixture native paste failure'};
            else result = {};
          }
        }
        queueMicrotask(() => this.emit('data', codec.encodeMessageFrame(JSON.stringify(
          {jsonrpc: '2.0', id: message.id, ...(error ? {error} : {result})}))));
      }
      return true;
    }
    end() { this.emit('close'); }
  }
  const previous = globalThis.nodeRepl;
  const priorConfig = process.env.OAI_SKY_CONFIG_PATH;
  delete process.env.OAI_SKY_CONFIG_PATH;
  globalThis.nodeRepl = {
    env: {LCU_MAC_SKY_SERVICE_PATH: join(source, 'service.js'),
      SKY_CUA_SERVICE_NATIVE_PIPE_PATH: endpoint, NODE_REPL_DISABLE_ANALYTICS: '1'},
    nativePipe: {async createConnection(address) {
      assert.equal(address, endpoint, 'never connect to a real native service');
      const pipe = new FakePipe(); pipes.push(pipe); return pipe;
    }},
    launchServices: {openApplication() { throw Error('real application launch forbidden in integration test'); }},
    async createElicitation(request) {
      approvals.push(request);
      return typeof approval === 'function' ? approval(request) : {action: approval};
    },
    async withSuspendedTimeout(run) { return run(); },
    addTurnEndedHandler() {},
    setResponseMeta() {},
  };
  t.after(() => {
    for (const pipe of pipes) pipe.end();
    client.transports.clear();
    if (previous === undefined) delete globalThis.nodeRepl;
    else globalThis.nodeRepl = previous;
    if (priorConfig === undefined) delete process.env.OAI_SKY_CONFIG_PATH;
    else process.env.OAI_SKY_CONFIG_PATH = priorConfig;
  });
  const patched = await import(`../../lcu/macos_sky_service.mjs?original-test=${randomUUID()}`);
  const original = await import(pathToFileURL(join(source, 'service.js')).href);
  const request = text => ({type: 'execute', method: 'type_text', args: [{app: target.bundleIdentifier, text}]});
  const actions = () => requests.filter(request => request.requestType === 'ComputerUseIPCAppPerformActionRequest')
    .map(request => request.request.action);
  return {patched, original, request, actions, approvals};
}

test('unpatched original JS forwards the complete Korean string to native type', {skip}, async t => {
  const f = await fixture(t);
  const text = 'LCU: 한글 입력 테스트 가나다 ABC 123';
  await f.original.handleRpc(f.request(text));
  assert.deepEqual(f.actions(), [{type: {_0: text}}]);
});

test('patched wrapper pastes a line with unmapped characters whole through original approval', {skip}, async t => {
  const f = await fixture(t);
  await f.patched.handleRpc(f.request('LCU: 한글 😀 e\u0301 中 ABC 123'));
  await f.patched.handleRpc(f.request('2024년 3월 15일 오후 3시'));
  assert.deepEqual(f.actions(), [
    {paste: {text: 'LCU: 한글 😀 e\u0301 中 ABC 123', format: 'text'}},
    {paste: {text: '2024년 3월 15일 오후 3시', format: 'text'}},
  ]);
  assert.deepEqual(f.approvals.map(approval => approval.meta.tool_name), ['paste', 'paste']);
  for (const approval of f.approvals) assert.equal(approval.meta.tool_params.app, target.bundleIdentifier);
});

test('ASCII typing retains one original native type action', {skip}, async t => {
  const f = await fixture(t);
  await f.patched.handleRpc(f.request('ASCII ABC 123\t^`~'));
  assert.deepEqual(f.actions(), [{type: {_0: 'ASCII ABC 123\t^`~'}}]);
});

test('Return and Tab stay native type actions between pasted chunks', {skip}, async t => {
  const f = await fixture(t);
  await f.patched.handleRpc(f.request('ASCII\n'));
  await f.patched.handleRpc(f.request('안녕 ñ\n'));
  await f.patched.handleRpc(f.request('é1\tñ2'));
  await f.patched.handleRpc(f.request('한글 abc\n'));
  assert.deepEqual(f.actions(), [
    {type: {_0: 'ASCII\n'}},
    {paste: {text: '안녕 ñ', format: 'text'}}, {type: {_0: '\n'}},
    {paste: {text: 'é1', format: 'text'}}, {type: {_0: '\t'}}, {paste: {text: 'ñ2', format: 'text'}},
    {paste: {text: '한글 abc', format: 'text'}}, {type: {_0: '\n'}},
  ]);
});

// The host side of approval persistence, modelled: the original asks on every call, and a
// host that recorded a session or always choice for the app answers from persisted state.
function persistingHost(choice, prompts) {
  const remembered = new Set();
  return request => {
    const app = request.meta.tool_params.app;
    if (remembered.has(app)) return {action: 'accept', content: {source: 'computer-use-persisted-state'}};
    prompts.push(request.meta.tool_name);
    const answer = choice(prompts.length);
    if (answer === 'session' || answer === 'always') {
      remembered.add(app);
      return {action: 'accept', content: {}, _meta: {persist: answer}};
    }
    return answer === 'once' ? {action: 'accept', content: {}} : {action: answer};
  };
}

const approvalText = 'a\n한글\nb\n가';

test('a session approval for the app asks once for every segment', {skip}, async t => {
  const prompts = [];
  const f = await fixture(t, {approval: persistingHost(() => 'session', prompts)});
  await f.patched.handleRpc(f.request(approvalText));
  assert.equal(f.actions().length, 4);
  assert.equal(f.approvals.length, 4, 'the original asks the host on every call');
  assert.deepEqual(prompts, ['type_text']);
});

test('a once-scoped approval asks for each segment', {skip}, async t => {
  const prompts = [];
  const f = await fixture(t, {approval: persistingHost(() => 'once', prompts)});
  await f.patched.handleRpc(f.request(approvalText));
  assert.equal(f.actions().length, 4);
  assert.deepEqual(prompts, ['type_text', 'paste', 'type_text', 'paste']);
});

test('declining a later once-scoped approval stops after the delivered text', {skip}, async t => {
  const prompts = [];
  const f = await fixture(t, {approval: persistingHost(count => count === 2 ? 'decline' : 'once', prompts)});
  await assert.rejects(f.patched.handleRpc(f.request(approvalText)), /not approved/);
  assert.deepEqual(f.actions(), [{type: {_0: 'a\n'}}]);
  assert.deepEqual(prompts, ['type_text', 'paste']);
});

test('original organization policy denial on the first segment prevents native input', {skip}, async t => {
  const f = await fixture(t, {decision: 'denied'});
  await assert.rejects(f.patched.handleRpc(f.request('a\n한글\nb')), /blocked from using/);
  assert.deepEqual(f.actions(), []);
  assert.equal(f.approvals.length, 0);
});

test('original user approval refusal on the first segment prevents native input', {skip}, async t => {
  const f = await fixture(t, {approval: 'decline'});
  await assert.rejects(f.patched.handleRpc(f.request('한글\nabc')), /not approved/);
  assert.deepEqual(f.actions(), []);
  assert.equal(f.approvals.length, 1);
});

test('original native paste error stops the sequence without a typing retry', {skip}, async t => {
  const f = await fixture(t, {failPaste: true});
  await assert.rejects(f.patched.handleRpc(f.request('ab\n한글\ncd')), /fixture native paste failure/);
  assert.deepEqual(f.actions(), [{type: {_0: 'ab\n'}}, {paste: {text: '한글', format: 'text'}}]);
});
