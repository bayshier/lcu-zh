import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {temporary, write} from './fixtures.mjs';

const STARTUP_FAILURE = 'Sky Computer Use native pipe startup failed';

// A hand-made original-service stand-in, not copied OpenAI code: its keyboard
// backend drops unmapped Unicode, while its existing paste backend retains it.
// `fail` maps a 0-based execute request index to the error that request throws
// once; `deny` names the method the original approval refuses ('*' for all).
async function fixture(t, {deny = null, fail = {}, recover = false, client = false} = {}) {
  const path = write(join(temporary(t), 'original-sky.mjs'), `
export const requests = [];
export let value = '';
const fail = ${JSON.stringify(fail)};
const deny = ${JSON.stringify(deny)};
let executed = 0;
export async function handleRpc(request) {
  requests.push(request);
  globalThis.unicodeEvents?.push(\`send \${request.method}\`);
  if (request.type !== 'execute') return {target: 'mac', methods: ['type_text', 'paste']};
  const index = executed++;
  if (fail[index]) {
    const message = fail[index];
    delete fail[index];
    throw new Error(message);
  }
  if (deny === '*' || request.method === deny) throw new Error('Computer Use was not approved');
  const input = request.args[0];
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(property => !('value' in property))) {
    throw new Error('app approval requires plain data properties');
  }
  if (request.method === 'type_text') {
    value += Array.from(input.text).filter(character => character.codePointAt(0) < 128).join('');
  } else if (request.method === 'paste') {
    value += input.text;
  }
  if (globalThis.afterOriginalAction) await globalThis.afterOriginalAction(request);
}
`);
  const previous = globalThis.nodeRepl;
  const recoveries = [];
  // A stand-in original client whose native turn-ended acknowledgement takes 30 ms.
  const clientPath = client && write(join(temporary(t), 'original-client.mjs'), `
export class MacComputerUseClient {
  async request(type, payload) {
    globalThis.unicodeEvents.push(\`\${type} \${payload.turnID} started\`);
    await new Promise(resolve => setTimeout(resolve, 30));
    globalThis.unicodeEvents.push(\`\${type} \${payload.turnID} acknowledged\`);
    return {};
  }
}
`);
  let turnEnded;
  globalThis.nodeRepl = {
    env: {LCU_MAC_SKY_SERVICE_PATH: path, ...(clientPath ? {LCU_MAC_SKY_CLIENT_PATH: clientPath} : {})},
    addTurnEndedHandler(handler) { turnEnded = handler; },
  };
  if (recover) {
    // The private host's answer, in memory: it proved the service stale and stopped it.
    globalThis.nodeRepl.env.LCU_MAC_LIFETIME_SOCKET = 'test-only:lifetime';
    globalThis.nodeRepl.nativePipe = {createConnection(address) {
      assert.equal(address, 'test-only:lifetime');
      const socket = new EventEmitter();
      socket.end = () => {};
      socket.write = data => {
        recoveries.push(JSON.parse(Buffer.from(data).toString('utf8')));
        queueMicrotask(() => socket.emit('data', Buffer.from('{"ok":true,"recovered":true}\n')));
        return true;
      };
      return socket;
    }};
  }
  t.after(() => {
    delete globalThis.afterOriginalAction;
    delete globalThis.unicodeEvents;
    if (previous === undefined) delete globalThis.nodeRepl;
    else globalThis.nodeRepl = previous;
  });
  const service = await import(`../../lcu/macos_sky_service.mjs?test=${randomUUID()}`);
  const original = await import(pathToFileURL(path).href);
  const type = text => service.handleRpc({type: 'execute', method: 'type_text',
    args: [{app: 'fixture.app', text}]});
  const sent = () => original.requests.filter(request => request.type === 'execute')
    .map(request => [request.method, request.args[0].text]);
  return {service, original, type, sent, recoveries, endTurn: (event = {}) => turnEnded.run(event)};
}

test('a line with unmapped characters is pasted whole, as one request', async t => {
  const f = await fixture(t);
  for (const text of ['LCU: 한글 입력 테스트 가나다 ABC 123', '2024년 3월 15일 오후 3시']) {
    const before = f.sent().length;
    assert.equal(await f.type(text), undefined);
    assert.deepEqual(f.sent().slice(before), [['paste', text]]);
  }
  for (const request of f.original.requests) {
    assert.deepEqual(Object.keys(request.args[0]), ['app', 'text', 'format']);
    assert.equal(request.args[0].app, 'fixture.app');
    assert.equal(request.args[0].format, 'text');
  }
});

test('control characters stay typed keys between pasted chunks', async t => {
  for (const [text, segments] of [
    ['안녕 ñ\n', [['paste', '안녕 ñ'], ['type_text', '\n']]],
    ['é1\tñ2', [['paste', 'é1'], ['type_text', '\t'], ['paste', 'ñ2']]],
    ['한글 abc\n', [['paste', '한글 abc'], ['type_text', '\n']]],
    ['ü\r\nü', [['paste', 'ü'], ['type_text', '\r\n'], ['paste', 'ü']]],
    ['abc\n가 나\n\ndef\n', [['type_text', 'abc\n'], ['paste', '가 나'], ['type_text', '\n\ndef\n']]],
  ]) {
    const f = await fixture(t);
    await f.type(text);
    assert.deepEqual(f.sent(), segments, JSON.stringify(text));
    assert.equal(f.original.value, text);
  }
});

test('emoji sequences and combining marks are never split', async t => {
  const f = await fixture(t);
  const text = 'a\u{1F600}b e\u0301 中文 \u{1F1F0}\u{1F1F7}.\nx\u{1F469}\u200D\u{1F4BB}';
  await f.type(text);
  assert.equal(f.original.value, text);
  assert.deepEqual(f.sent(), [
    ['paste', 'a\u{1F600}b e\u0301 中文 \u{1F1F0}\u{1F1F7}.'],
    ['type_text', '\n'],
    ['paste', 'x\u{1F469}\u200D\u{1F4BB}'],
  ]);
});

test('a lone surrogate is passed on unchanged in its pasted chunk', async t => {
  const f = await fixture(t);
  await f.type('a\uD800b\nc');
  assert.deepEqual(f.sent(), [['paste', 'a\uD800b'], ['type_text', '\nc']]);
});

test('further arguments are kept on every segment', async t => {
  const f = await fixture(t);
  const extra = {fixture: true};
  await f.service.handleRpc({type: 'execute', method: 'type_text',
    args: [{app: 'fixture.app', text: '한\n'}, extra]});
  assert.deepEqual(f.sent(), [['paste', '한'], ['type_text', '\n']]);
  for (const request of f.original.requests) {
    assert.equal(request.args.length, 2);
    assert.equal(request.args[1], extra);
  }
});

test('ASCII and empty input retain one original type_text request each', async t => {
  const f = await fixture(t);
  await f.type('ABC 123\t\n^`~\'"');
  await f.type('');
  assert.equal(f.original.value, 'ABC 123\t\n^`~\'"');
  assert.deepEqual(f.sent(), [['type_text', 'ABC 123\t\n^`~\'"'], ['type_text', '']]);
});

test('approval denial on the first segment sends nothing', async t => {
  const f = await fixture(t, {deny: '*'});
  await assert.rejects(f.type('한글\nabc'), /Computer Use was not approved/);
  assert.equal(f.original.value, '');
  assert.deepEqual(f.sent(), [['paste', '한글']]);
});

test('a later denial stops the sequence after the delivered segments', async t => {
  const f = await fixture(t, {deny: 'paste'});
  await assert.rejects(f.type('abc\n한글\ndef'), /Computer Use was not approved/);
  assert.equal(f.original.value, 'abc\n');
  assert.deepEqual(f.sent(), [['type_text', 'abc\n'], ['paste', '한글']]);
});

test('a paste failure mid-sequence stops without a typing fallback or a resend', async t => {
  const f = await fixture(t, {fail: {1: 'original paste failed'}});
  await assert.rejects(f.type('ab\n한글\ncd'), /original paste failed/);
  assert.equal(f.original.value, 'ab\n');
  assert.deepEqual(f.sent(), [['type_text', 'ab\n'], ['paste', '한글']]);
});

test('stale-service recovery on one segment retries only that segment', async t => {
  const f = await fixture(t, {fail: {2: STARTUP_FAILURE}, recover: true});
  const text = 'ab\n한글\ncd\n가\nef';
  await f.type(text);
  assert.equal(f.original.value, text);
  assert.deepEqual(f.recoveries, [{type: 'recover'}]);
  assert.deepEqual(f.sent(), [
    ['type_text', 'ab\n'],
    ['paste', '한글'],
    ['type_text', '\ncd\n'],
    ['type_text', '\ncd\n'],
    ['paste', '가'],
    ['type_text', '\nef'],
  ]);
});

test('without a recovery a stale-service failure stops the sequence unchanged', async t => {
  const f = await fixture(t, {fail: {1: STARTUP_FAILURE}});
  await assert.rejects(f.type('ab\n한글\ncd'), error => error.message === STARTUP_FAILURE);
  assert.equal(f.original.value, 'ab\n');
  assert.deepEqual(f.sent(), [['type_text', 'ab\n'], ['paste', '한글']]);
});

test('the end of the request\'s own turn stops the remaining segments', async t => {
  const f = await fixture(t);
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {session_id: 'session', turn_id: 'turn'}};
  globalThis.afterOriginalAction = async request => {
    if (request.method === 'paste') await f.endTurn({session_id: 'session', turn_id: 'turn'}).catch(() => {});
  };
  await assert.rejects(f.type('ab\n한글\ncd'), /turn ended before every segment was sent/);
  assert.deepEqual(f.sent(), [['type_text', 'ab\n'], ['paste', '한글']]);
});

test('another turn ending, such as a subagent\'s, does not stop the segments', async t => {
  const f = await fixture(t);
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {session_id: 'session', turn_id: 'turn'}};
  globalThis.afterOriginalAction = async request => {
    if (request.method === 'paste') await f.endTurn({session_id: 'agent', turn_id: 'turn'}).catch(() => {});
  };
  await f.type('ab\n한글\ncd');
  assert.deepEqual(f.sent(), [['type_text', 'ab\n'], ['paste', '한글'], ['type_text', '\ncd']]);
});

test('another turn of the same session, as a Claude subagent\'s, does not stop the segments', async t => {
  const f = await fixture(t);
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {session_id: 'session', turn_id: 'turn'}};
  globalThis.afterOriginalAction = async request => {
    if (request.method === 'paste') await f.endTurn({session_id: 'session', turn_id: 'subagent'}).catch(() => {});
  };
  await f.type('ab\n한글\ncd');
  assert.deepEqual(f.sent(), [['type_text', 'ab\n'], ['paste', '한글'], ['type_text', '\ncd']]);
});

test('a segment after another turn ends waits for that turn\'s native cleanup', async t => {
  const f = await fixture(t, {client: true});
  globalThis.unicodeEvents = [];
  // The other turn sent a request first, so its end has native cleanup to acknowledge.
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {session_id: 'session', turn_id: 'subagent'}};
  await f.type('x');
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {session_id: 'session', turn_id: 'turn'}};
  let hook;
  globalThis.afterOriginalAction = async request => {
    if (request.method === 'paste') hook = f.endTurn({session_id: 'session', turn_id: 'subagent'}).catch(() => {});
  };
  await f.type('ab\n한글\ncd');
  await hook;
  assert.deepEqual(f.sent().slice(1), [['type_text', 'ab\n'], ['paste', '한글'], ['type_text', '\ncd']]);
  assert.deepEqual(globalThis.unicodeEvents, [
    'send type_text', 'send type_text', 'send paste',
    'ComputerUseIPCCodexTurnEndedRequest subagent started',
    'ComputerUseIPCCodexTurnEndedRequest subagent acknowledged',
    'send type_text',
  ]);
});

test('without turn metadata any turn end stops the remaining segments', async t => {
  const f = await fixture(t);
  globalThis.afterOriginalAction = async request => {
    if (request.method === 'paste') await f.endTurn({session_id: 'other', turn_id: 'turn'}).catch(() => {});
  };
  await assert.rejects(f.type('ab\n한글\ncd'), /turn ended before every segment was sent/);
  assert.deepEqual(f.sent(), [['type_text', 'ab\n'], ['paste', '한글']]);
});

test('concurrent segmented requests never interleave, and an error does not block the next', async t => {
  const f = await fixture(t, {fail: {1: 'original paste failed'}});
  globalThis.afterOriginalAction = () => new Promise(resolve => setTimeout(resolve, 5));
  const results = await Promise.allSettled([f.type('a\n가'), f.type('b\n나\nc'), f.type('d\n다')]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(f.sent(), [
    ['type_text', 'a\n'], ['paste', '가'],
    ['type_text', 'b\n'], ['paste', '나'], ['type_text', '\nc'],
    ['type_text', 'd\n'], ['paste', '다'],
  ]);
});

test('setup and explicit paste pass through unchanged', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.handleRpc({type: 'setup'}),
    {target: 'mac', methods: ['type_text', 'paste']});
  const request = {type: 'execute', method: 'paste', args: [{app: 'fixture.app', text: '한글 abc\n', format: 'md'}]};
  await f.service.handleRpc(request);
  assert.equal(f.original.requests.length, 2);
  assert.equal(f.original.requests[1], request);
});

test('Unicode routing does not mutate a frozen caller request or treat text as HTML', async t => {
  const f = await fixture(t);
  const input = Object.freeze({app: 'fixture.app', text: '<b>한글</b>', format: 'html'});
  const request = Object.freeze({type: 'execute', method: 'type_text', args: Object.freeze([input])});
  await f.service.handleRpc(request);
  assert.equal(f.original.value, '<b>한글</b>');
  assert.deepEqual(f.original.requests.map(request => [request.method, request.args[0].format]),
    [['paste', 'text']]);
  assert.equal(input.format, 'html');
  assert.equal(input.text, '<b>한글</b>');
  assert.equal(request.method, 'type_text');
});

test('invalid accessor input reaches original validation without invoking the getter', async t => {
  const f = await fixture(t);
  let called = false;
  const input = {app: 'fixture.app', text: '한글'};
  Object.defineProperty(input, 'extra', {enumerable: true, get() { called = true; return 'value'; }});
  const request = {type: 'execute', method: 'type_text', args: [input]};
  await assert.rejects(f.service.handleRpc(request), /plain data properties/);
  assert.equal(called, false);
  assert.equal(f.original.requests.length, 1);
  assert.equal(f.original.requests[0], request);
});

test('Unicode routing retains non-enumerable app and text accepted by original policy', async t => {
  const f = await fixture(t);
  const input = Object.defineProperties({}, {
    app: {value: 'fixture.app'},
    text: {value: 'a\n한글'},
  });
  await f.service.handleRpc({type: 'execute', method: 'type_text', args: [input]});
  assert.equal(f.original.value, 'a\n한글');
  for (const request of f.original.requests) {
    const passed = request.args[0];
    assert.equal(passed.app, 'fixture.app');
    assert.equal(Object.getOwnPropertyDescriptor(passed, 'app').enumerable, false);
    assert.equal(Object.getOwnPropertyDescriptor(passed, 'text').enumerable, false);
  }
  assert.equal(f.original.requests[1].args[0].format, 'text');
});
