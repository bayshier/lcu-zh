import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection, createServer} from 'node:net';
import {pathToFileURL} from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'lcu-macos-control-'));
const controlPath = join(root, 'control.sock');
const lifetimePath = join(root, 'lifetime.sock');
const servicePath = join(root, 'original-service.mjs');
const clientPath = join(root, 'original-client.mjs');
const wrapperPath = new URL('../lcu/macos_sky_service.mjs', import.meta.url);
const metadata = {session_id: 'session-fixture', turn_id: 'turn-fixture', call_id: 'call-fixture'};
const originalMetadata = {...metadata};
const sessionId = metadata.session_id;
const turnId = metadata.turn_id;
const calls = [];
const policyCalls = [];
let completeAction;
let turnEnded;
let serviceSocket;
let failTurnEndedOnce = false;
const pending = new Map();
const observedContexts = [];
const lifetimeMessages = [];
const turnAnnouncements = [];
const recoverRequests = [];
const recoverClosed = [];
let recoverReply;
let recoverDelayMs = 0;
// When set, the recover reply waits for this promise.
let recoverHold;
let lifetimeReplies = 0;
// Decides how the private lifetime host answers: {notified, error?, hold?}, where
// hold is a promise the reply waits for.
let lifetimeBehavior = () => ({notified: true});

await writeFile(servicePath, `export async function handleRpc(request) {
  globalThis.originalRpcCount = (globalThis.originalRpcCount || 0) + 1;
  if (request.failUntilRecovered && !globalThis.hostRecovered) {
    throw new Error('Sky Computer Use native pipe startup failed');
  }
  if (request.fail) {
    const error = Object.assign(new Error(request.fail), {code: -10001, errorName: 'fixtureFailure'});
    globalThis.lastThrown = request.freeze ? Object.freeze(error) : error;
    throw globalThis.lastThrown;
  }
  if (request.wait) return new Promise(resolve => { globalThis.completeAction = resolve; });
  return {ok: true};
}\n`);
await writeFile(clientPath, `export class MacComputerUseClient {
  async getAppPolicy(selector, options) {
    globalThis.policyCalls.push({selector, metadata: options.codexMetadata,
      timeoutSeconds: options.timeoutSeconds});
    const bundleIdentifier = ({
      'com.fixture.A': 'com.fixture.A',
      'Fixture A': 'com.fixture.A',
      '/Applications/Fixture A.app': 'com.fixture.A',
      'Fixture Denied': 'com.fixture.B',
      'Fixture B': 'com.fixture.B',
    })[selector];
    if (!bundleIdentifier) throw new Error('unknown app selector');
    return {decision:selector === 'Fixture Denied' ? 'denied' : 'allowed',
      target:{bundleIdentifier, appPath:'/Applications/Fixture.app',
      displayName:selector, risk:'low'}};
  }
  async request(requestType, payload, options) {
    globalThis.calls.push({requestType, payload, metadata: options.codexMetadata,
      timeoutSeconds: options.timeoutSeconds});
    if (requestType === 'ComputerUseIPCCodexTurnEndedRequest' && globalThis.turnEndedGate) {
      await globalThis.turnEndedGate;
    }
    if (requestType === 'ComputerUseIPCCodexTurnEndedRequest' && globalThis.failTurnEndedCount > 0) {
      globalThis.failTurnEndedCount--;
      throw new Error(globalThis.failTurnEndedMessage);
    }
    if (requestType === 'ComputerUseIPCCodexTurnEndedRequest' && globalThis.failTurnEndedOnce) {
      globalThis.failTurnEndedOnce = false;
      throw new Error('fixture native turn-ended failure');
    }
    if (requestType === 'ComputerUseIPCCodexStatusItemMenuStateRequest') {
      if (globalThis.statusGate) await globalThis.statusGate;
      return {
      computerUse: {activeApplications: [
        {id:'/Applications/Fixture A.app', name:'Fixture A', bundleIdentifier:'com.fixture.A', bundleURL:'file:///Applications/Fixture%20A.app'},
        {id:'/Applications/Fixture B.app', name:'Fixture B', bundleIdentifier:'com.fixture.B', bundleURL:'file:///Applications/Fixture%20B.app'},
      ]}, computerHistory: {state:'stopped'},
      };
    }
  }
}\n`);

function consumeLines(socket, callback) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      callback(JSON.parse(line));
    }
  });
}

const controlServer = createServer(socket => consumeLines(socket, message => {
  if (message.type === 'service') {
    serviceSocket = socket;
    return;
  }
  if (socket === serviceSocket) {
    if (message.type === 'context') observedContexts.push(message);
    if (message.type !== 'result') return;
    pending.get(message.request_id)?.end(`${JSON.stringify(message.response)}\n`);
    pending.delete(message.request_id);
    return;
  }
  pending.set(message.request_id, socket);
  serviceSocket?.write(`${JSON.stringify(message)}\n`);
}));
const lifetimeServer = createServer(socket => consumeLines(socket, message => {
  if (message.type === 'recover') {
    recoverRequests.push(message);
    socket.once('end', () => recoverClosed.push(message));
    // undefined: never answer, as a host stuck behind other work would.
    if (recoverReply === undefined) return;
    Promise.resolve(recoverHold).then(() => setTimeout(() => {
      // The host reports `recovered` only after the stale service has exited.
      try { if (JSON.parse(recoverReply).recovered === true) globalThis.hostRecovered = true; } catch {}
      socket.end(`${recoverReply}\n`);
    }, recoverDelayMs));
    return;
  }
  if (message.type === 'turn') {
    turnAnnouncements.push(message);
    socket.end('{"ok":true}\n');
    return;
  }
  lifetimeMessages.push(message);
  const {hold, ...reply} = lifetimeBehavior(message);
  Promise.resolve(hold).then(() => {
    lifetimeReplies += 1;
    socket.end(`${JSON.stringify(reply)}\n`);
  });
}));

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => resolve(socket));
    socket.once('error', reject);
  });
}

function control(request) {
  return new Promise(async (resolve, reject) => {
    const socket = await connect(controlPath);
    consumeLines(socket, resolve);
    socket.once('error', reject);
    socket.write(`${JSON.stringify({deadline_unix_ms: Date.now() + 40000, ...request})}\n`);
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

try {
  await Promise.all([listen(controlServer, controlPath), listen(lifetimeServer, lifetimePath)]);
  globalThis.calls = calls;
  globalThis.policyCalls = policyCalls;
  globalThis.failTurnEndedOnce = false;
  globalThis.failTurnEndedCount = 0;
  globalThis.originalRpcCount = 0;
  globalThis.nodeRepl = {
    env: {LCU_MAC_CONTROL_SOCKET: controlPath,
      LCU_MAC_LIFETIME_SOCKET: lifetimePath,
      LCU_MAC_SKY_SERVICE_PATH: servicePath, LCU_MAC_SKY_CLIENT_PATH: clientPath},
    requestMeta: {'x-codex-turn-metadata': metadata},
    nativePipe: {createConnection: connect},
    addTurnEndedHandler: handler => { turnEnded = handler; },
  };
  const {handleRpc, LIFETIME_SIGNAL_TIMEOUT_MS} = await import(
    pathToFileURL(new URL(wrapperPath).pathname).href);
  const action = handleRpc({type: 'execute', method: 'click',
    args: [{app: 'com.fixture.A'}], wait: true});
  await waitFor(() => Boolean(turnEnded), 'original turn-ended hook was not registered');
  // The original host gives all turn-ended handlers 5 s, so ours must return sooner;
  // slower cleanup stays pending and is retried before the next Sky request.
  assert.ok(turnEnded.timeoutMs > 0 && turnEnded.timeoutMs <= 4_000);
  assert.ok(turnEnded.timeoutMs < 5_000);
  // The JS wait for the private lifetime host must outlast the host's own limit.
  const {TURN_ENDED_CLI_TIMEOUT_SECONDS: hostTimeoutSeconds} = await import(
    new URL('../lcu/macos_host.mjs', import.meta.url).href);
  assert.ok(hostTimeoutSeconds >= 6, 'the host must outlast the helper\'s ~5.2 s run');
  assert.equal(LIFETIME_SIGNAL_TIMEOUT_MS, hostTimeoutSeconds * 1000 + 2000);
  await waitFor(() => observedContexts.some(context => context.app === 'com.fixture.A'),
    'trusted service did not publish the current app context');
  metadata.turn_id = 'mutated-after-dispatch';

  const status = await control({type: 'status', session_id: sessionId, turn_id: turnId});
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(status.result.computerUse.activeApplications.map(app => app.bundleIdentifier),
    ['com.fixture.A']);
  const foreign = await control({type: 'stop', session_id: 'other-session',
    turn_id: turnId, app: 'com.fixture.A'});
  assert.equal(foreign.ok, false);
  const unobserved = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.B'});
  assert.equal(unobserved.ok, false);
  assert.equal(calls.some(call => call.requestType === 'ComputerUseIPCAppStopRequest'), false);

  // Original Mac policy resolves aliases and app paths to its canonical ID.
  // Keep three selector forms active in one turn and require status to expose
  // only the original resolved bundle ID.
  const aliases = [
    ['Fixture A', 'alias-call'],
    ['/Applications/Fixture A.app', 'path-call'],
  ];
  for (const [selector, callId] of aliases) {
    globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
      ...originalMetadata, call_id: callId,
    }};
    await handleRpc({type: 'execute', method: 'click', args: [{app: selector}]});
  }
  const aliasStatus = await control({type: 'status', session_id: sessionId, turn_id: turnId});
  assert.equal(aliasStatus.ok, true, JSON.stringify(aliasStatus));
  assert.deepEqual(aliasStatus.result.computerUse.activeApplications.map(app => app.bundleIdentifier),
    ['com.fixture.A']);
  assert.deepEqual(policyCalls.map(call => call.selector), [
    'Fixture A', '/Applications/Fixture A.app',
  ]);
  assert.ok(policyCalls.every(call => call.timeoutSeconds > 0 && call.timeoutSeconds <= 5));
  assert.equal(calls.find(call =>
    call.requestType === 'ComputerUseIPCCodexStatusItemMenuStateRequest').timeoutSeconds, 15);

  const stop = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.A'});
  assert.deepEqual(stop, {ok: true, result: {accepted: true, applicationId: 'com.fixture.A'}});
  const stopCall = calls.find(call => call.requestType === 'ComputerUseIPCAppStopRequest');
  assert.deepEqual(stopCall, {requestType: 'ComputerUseIPCAppStopRequest',
    payload: {app: '/Applications/Fixture A.app'}, metadata: originalMetadata, timeoutSeconds: 15});

  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: sessionId, turn_id: turnId, call_id: 'denied-call',
  }};
  await handleRpc({type: 'execute', method: 'click', args: [{app: 'Fixture Denied'}]});
  const deniedStop = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.B'});
  assert.equal(deniedStop.ok, false);
  assert.match(deniedStop.error, /not targeted/);
  assert.equal(calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').length, 1);

  // The app selected for Stop determines the metadata sent with AppStop even
  // when this turn has several active app contexts.
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: sessionId, turn_id: turnId, call_id: 'call-fixture-B',
  }};
  await handleRpc({type: 'execute', method: 'click', args: [{app: 'Fixture B'}]});
  const stopB = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.B'});
  assert.equal(stopB.ok, true, JSON.stringify(stopB));
  const stopBCall = calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').at(-1);
  assert.equal(stopBCall.payload.app, '/Applications/Fixture B.app');
  assert.equal(stopBCall.metadata.call_id, 'call-fixture-B');

  completeAction = globalThis.completeAction;
  completeAction({ok: true});
  await action;
  const betweenCalls = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.A'});
  assert.equal(betweenCalls.ok, true, JSON.stringify(betweenCalls));

  const priorStopCount = calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').length;
  globalThis.statusGate = new Promise(resolve => { globalThis.releaseStatus = resolve; });
  const deferredStop = control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.A'});
  await waitFor(() => calls.filter(call =>
    call.requestType === 'ComputerUseIPCCodexStatusItemMenuStateRequest').length >= 4,
  'deferred original status request did not start');
  await turnEnded.run({session_id: sessionId, turn_id: turnId});
  globalThis.releaseStatus();
  globalThis.statusGate = undefined;
  const stoppedAfterEnd = await deferredStop;
  assert.equal(stoppedAfterEnd.ok, false);
  assert.equal(calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').length,
    priorStopCount);
  const ended = await control({type: 'status', session_id: sessionId, turn_id: turnId});
  assert.equal(ended.ok, false);
  const nativeEnded = calls.find(call =>
    call.requestType === 'ComputerUseIPCCodexTurnEndedRequest');
  assert.deepEqual(nativeEnded, {requestType: 'ComputerUseIPCCodexTurnEndedRequest',
    payload: {threadID: sessionId, turnID: turnId},
    metadata: {session_id: sessionId, turn_id: turnId, call_id: 'call-fixture-B'},
    timeoutSeconds: 15});
  assert.deepEqual(lifetimeMessages, [{session_id: sessionId, turn_id: turnId}]);
  assert.deepEqual(turnAnnouncements, [{type: 'turn', session_id: sessionId, turn_id: turnId}],
    'the host learns of the open turn once, at its first Sky request');

  const oldServiceSocket = serviceSocket;
  let oldServiceClosed = false;
  oldServiceSocket.once('close', () => { oldServiceClosed = true; });
  await new Promise(resolve => oldServiceSocket.write('{"type":"status"', resolve));
  await new Promise(resolve => setTimeout(resolve, 10));
  oldServiceSocket.destroy();
  await waitFor(() => oldServiceClosed, 'old trusted service connection did not close');
  const nextMetadata = {session_id: 'next-session', turn_id: 'next-turn'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': nextMetadata};
  await handleRpc({type: 'execute', method: 'click', args: [{app: 'com.fixture.B'}]});
  await waitFor(() => serviceSocket && serviceSocket !== oldServiceSocket &&
    observedContexts.some(context => context.app === 'com.fixture.B'),
  'trusted control connection did not reconnect with a new app context');
  const reconnected = await control({type: 'status', session_id: 'next-session', turn_id: 'next-turn'});
  assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
  assert.deepEqual(reconnected.result.computerUse.activeApplications.map(app => app.bundleIdentifier),
    ['com.fixture.B']);

  globalThis.failTurnEndedOnce = true;
  const lifetimeCountBeforeFailure = lifetimeMessages.length;
  await assert.rejects(turnEnded.run({session_id: 'next-session', turn_id: 'next-turn'}),
    /fixture native turn-ended failure/);
  assert.equal(lifetimeMessages.length, lifetimeCountBeforeFailure,
    'CLI cleanup must wait for the native turn-ended acknowledgement');
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: 'after-cleanup', turn_id: 'after-cleanup-turn', call_id: 'fresh-call',
  }};
  assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
  const retryNativeEnded = calls.filter(call =>
    call.requestType === 'ComputerUseIPCCodexTurnEndedRequest').slice(-2);
  assert.deepEqual(retryNativeEnded.map(call => call.payload), [
    {threadID: 'next-session', turnID: 'next-turn'},
    {threadID: 'next-session', turnID: 'next-turn'},
  ]);
  assert.deepEqual(retryNativeEnded.map(call => call.metadata), [nextMetadata, nextMetadata]);
  assert.deepEqual(lifetimeMessages.at(-1), {session_id: 'next-session', turn_id: 'next-turn'});

  // The original host stops waiting for the hook after its own limit (here:
  // we simply do not await it). Slow native cleanup must keep running, finish
  // both steps, and hold back the next Sky request until it does.
  const slowMetadata = {session_id: 'slow-session', turn_id: 'slow-turn', call_id: 'slow-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': slowMetadata};
  await handleRpc({type: 'execute', method: 'list_apps', args: []});
  globalThis.turnEndedGate = new Promise(resolve => { globalThis.releaseTurnEnded = resolve; });
  const slowLifetimeCount = lifetimeMessages.length;
  const abandoned = turnEnded.run({session_id: slowMetadata.session_id, turn_id: slowMetadata.turn_id});
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: 'after-slow', turn_id: 'after-slow-turn', call_id: 'after-slow-call'}};
  const rpcCountBeforeSlow = globalThis.originalRpcCount;
  let nextDispatched = false;
  // Emulate the original worker's lifecycle race: the hook gets its registered
  // timeoutMs, after which the host moves on while cleanup keeps running.
  const outcome = await Promise.race([
    abandoned.then(() => 'finished'),
    new Promise(resolve => setTimeout(() => resolve('expired'), turnEnded.timeoutMs)),
  ]);
  assert.equal(outcome, 'expired', 'the gated native cleanup must outlast the hook budget');
  const next = handleRpc({type: 'execute', method: 'list_apps', args: []}).then(() => { nextDispatched = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(nextDispatched, false, 'a Sky request must wait for pending turn cleanup');
  assert.equal(globalThis.originalRpcCount, rpcCountBeforeSlow);
  assert.equal(lifetimeMessages.length, slowLifetimeCount, 'CLI cleanup must wait for native cleanup');
  globalThis.releaseTurnEnded();
  globalThis.turnEndedGate = undefined;
  await abandoned;
  await next;
  assert.deepEqual(lifetimeMessages.at(-1), {session_id: 'slow-session', turn_id: 'slow-turn'});
  assert.equal(globalThis.originalRpcCount, rpcCountBeforeSlow + 1);
  await turnEnded.run({session_id: 'after-slow', turn_id: 'after-slow-turn'});

  // The original CLI command is not the gate for native cleanup: a failing or
  // slow one must never fail a Sky request or stop another turn's cleanup.
  const originalConsoleError = console.error;
  const stderr = [];
  console.error = (...args) => { stderr.push(args.join(' ')); };
  try {
    const withoutMetadata = () => { globalThis.nodeRepl.requestMeta = {}; };
    const countFor = session => lifetimeMessages.filter(message => message.session_id === session).length;
    const startTurn = async name => {
      const turn = {session_id: `${name}-session`, turn_id: `${name}-turn`, call_id: `${name}-call`};
      globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': turn};
      await handleRpc({type: 'execute', method: 'list_apps', args: []});
      return turn;
    };
    const endTurn = turn => turnEnded.run({session_id: turn.session_id, turn_id: turn.turn_id});
    lifetimeBehavior = message => message.session_id === 'cli-fail-session'
      ? {notified: false, error: 'fixture CLI failure'} : {notified: true};
    const failTurn = await startTurn('cli-fail');
    const okTurn = await startTurn('cli-ok');
    const thirdTurn = await startTurn('cli-third');
    const cliLifetimeStart = lifetimeMessages.length;
    globalThis.turnEndedGate = new Promise(resolve => { globalThis.releaseTurnEnded = resolve; });
    const cliHooks = [endTurn(failTurn), endTurn(okTurn)];
    globalThis.releaseTurnEnded();
    globalThis.turnEndedGate = undefined;
    // A CLI failure is not a hook failure: the native step was acknowledged.
    await Promise.all(cliHooks);
    await waitFor(() => lifetimeMessages.length >= cliLifetimeStart + 2,
      'the failing turn must not stop cleanup of the next one');
    await waitFor(() => stderr.some(line => /failed for cli-fail-session\/cli-fail-turn after \d+ ms.*retrying once/.test(line)),
      'the first CLI failure was not recorded');
    assert.equal(countFor('cli-fail-session'), 1);
    assert.equal(countFor('cli-ok-session'), 1);
    // Another turn ending runs its own background cleanup but must not spend the
    // failed command's retry, which belongs to the next Sky request.
    await endTurn(thirdTurn);
    await waitFor(() => countFor('cli-third-session') === 1, 'the next turn was not cleaned up');
    assert.equal(countFor('cli-fail-session'), 1);
    // The next Sky request retries once; the failure drops the item without failing it.
    withoutMetadata();
    const rpcBeforeRetry = globalThis.originalRpcCount;
    assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
    assert.equal(globalThis.originalRpcCount, rpcBeforeRetry + 1);
    assert.equal(countFor('cli-fail-session'), 2);
    assert.equal(countFor('cli-ok-session'), 1);
    assert.equal(stderr.filter(line => /failed for cli-fail-session\/cli-fail-turn after \d+ ms; native turn-ended was acknowledged; continuing$/.test(line)).length, 1);
    // The following request dispatches without retrying again.
    const lifetimeAfterDrop = lifetimeMessages.length;
    assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
    assert.equal(lifetimeMessages.length, lifetimeAfterDrop);
    assert.equal(globalThis.originalRpcCount, rpcBeforeRetry + 2);

    // The hook only waits for native cleanup. A slow CLI command finishes in the
    // background and holds back the next Sky request until it is done.
    let releaseLifetime;
    lifetimeBehavior = () => ({notified: true,
      hold: new Promise(resolve => { releaseLifetime = resolve; })});
    const lateTurn = await startTurn('cli-late');
    const repliesBeforeLate = lifetimeReplies;
    await endTurn(lateTurn);
    await waitFor(() => countFor('cli-late-session') === 1, 'the CLI command was not started in the background');
    assert.equal(lifetimeReplies, repliesBeforeLate, 'the hook must not wait for the CLI command');
    withoutMetadata();
    const rpcBeforeLate = globalThis.originalRpcCount;
    let lateDispatched = false;
    const afterLate = handleRpc({type: 'execute', method: 'list_apps', args: []})
      .then(() => { lateDispatched = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(lateDispatched, false, 'a Sky request must wait for the running CLI command');
    assert.equal(globalThis.originalRpcCount, rpcBeforeLate);
    releaseLifetime();
    await afterLate;
    assert.equal(lifetimeReplies, repliesBeforeLate + 1);
    assert.equal(globalThis.originalRpcCount, rpcBeforeLate + 1);
    assert.equal(countFor('cli-late-session'), 1);
    lifetimeBehavior = () => ({notified: true});
  } finally {
    console.error = originalConsoleError;
  }

  globalThis.nodeRepl.env.LCU_MAC_CONTROL_SOCKET = undefined;
  const noControlMetadata = {session_id: 'no-control-session', turn_id: 'no-control-turn',
    call_id: 'no-control-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': noControlMetadata};
  await handleRpc({type: 'execute', method: 'list_apps', args: []});
  await turnEnded.run({session_id: noControlMetadata.session_id,
    turn_id: noControlMetadata.turn_id});
  const noControlEnded = calls.at(-1);
  assert.equal(noControlEnded.requestType, 'ComputerUseIPCCodexTurnEndedRequest');
  assert.deepEqual(noControlEnded.payload, {threadID: noControlMetadata.session_id,
    turnID: noControlMetadata.turn_id});
  assert.deepEqual(noControlEnded.metadata, noControlMetadata);

  // A native pipe startup failure asks the private host to recover from a provably stale
  // service. Only when the host reports that it stopped one is the request retried, once.
  globalThis.nodeRepl.requestMeta = {};
  const startupFailure = 'Sky Computer Use native pipe startup failed';
  const recovered = JSON.stringify({ok: true, recovered: true, pid: 321, path: '/fixture', elapsed_ms: 120});
  const notRecovered = JSON.stringify({ok: true, recovered: false, reason: 'no stale service'});
  const rpc = extra => handleRpc({type: 'execute', method: 'list_apps', args: [], ...extra});
  const failure = extra => rpc(extra).then(() => assert.fail('the original error must be thrown'), error => error);
  const countOriginal = () => globalThis.originalRpcCount;
  const reset = () => { globalThis.hostRecovered = false; recoverDelayMs = 0; };

  // Recovered: one recovery request, one retry, and the retry's result is returned.
  reset();
  recoverReply = recovered;
  let rpcBefore = countOriginal();
  assert.deepEqual(await rpc({failUntilRecovered: true}), {ok: true});
  assert.equal(recoverRequests.length, 1);
  assert.equal(recoverRequests[0].type, 'recover');
  // No wall-clock deadline crosses processes: the host signals only while this connection
  // is still open, and the client closes it when it gives up.
  assert.deepEqual(recoverRequests[0], {type: 'recover'});
  assert.equal(countOriginal(), rpcBefore + 2, 'the request runs once, fails, and is retried exactly once');

  // The retry is the last attempt: a persisting failure is thrown after exactly one retry
  // and one recovery, with the retry's own error object.
  reset();
  rpcBefore = countOriginal();
  let recoveriesBefore = recoverRequests.length;
  const persisting = await failure({fail: startupFailure});
  assert.equal(persisting.message, startupFailure);
  assert.equal(persisting.code, -10001);
  assert.equal(countOriginal(), rpcBefore + 2);
  assert.equal(recoverRequests.length, recoveriesBefore + 1);

  // Not recovered (healthy service, failed or inconclusive check): no retry, the original
  // error object comes back unchanged.
  for (const reply of [
    notRecovered,
    JSON.stringify({ok: true, recovered: 'yes'}),
    JSON.stringify({ok: false, error: 'ps exited with status 1.'}),
    JSON.stringify({recovered: true}),
    '{not json',
    '[]',
  ]) {
    reset();
    recoverReply = reply;
    rpcBefore = countOriginal();
    recoveriesBefore = recoverRequests.length;
    const error = await failure({fail: startupFailure});
    assert.equal(error, globalThis.lastThrown, 'the very same error object');
    assert.equal(error.message, startupFailure, reply);
    assert.equal(error.errorName, 'fixtureFailure');
    assert.equal(countOriginal(), rpcBefore + 1, `no retry for ${reply}`);
    assert.equal(recoverRequests.length, recoveriesBefore + 1);
  }

  // Messages that only contain the words (a validation or approval error) are not a native
  // pipe startup failure and never reach the host.
  reset();
  recoverReply = recovered;
  recoveriesBefore = recoverRequests.length;
  for (const message of [`Sky runtime method is not available: ${startupFailure}`, `${startupFailure}: more`,
    'Sky Computer Use service startup request failed', startupFailure.toLowerCase()]) {
    assert.equal((await failure({fail: message})).message, message);
  }
  assert.equal(recoverRequests.length, recoveriesBefore);

  // Other failures never ask the host to do anything.
  reset();
  recoverReply = recovered;
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  assert.equal((await failure({fail: 'Sky Computer Use request failed'})).message, 'Sky Computer Use request failed');
  assert.equal(recoverRequests.length, recoveriesBefore);
  assert.equal(countOriginal(), rpcBefore + 1);

  // Concurrent failures share one recovery, and each is retried once.
  reset();
  let releaseRecovery;
  recoverHold = new Promise(resolve => { releaseRecovery = resolve; });
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  const concurrent = Promise.all([1, 2, 3].map(() => rpc({failUntilRecovered: true})));
  // The host answers only once all three have failed, so all three join the one recovery.
  await waitFor(() => countOriginal() === rpcBefore + 3, 'the three requests did not all fail first');
  releaseRecovery();
  const results = await concurrent;
  recoverHold = undefined;
  assert.deepEqual(results, [{ok: true}, {ok: true}, {ok: true}]);
  assert.equal(recoverRequests.length, recoveriesBefore + 1, 'concurrent requests share one recovery');
  assert.equal(countOriginal(), rpcBefore + 6);

  // A turn that ends (Stop or Interrupt) while its request waits for the recovery is not
  // acted on afterwards: the original error comes back and the request is not sent again.
  reset();
  const endedMetadata = {session_id: 'ended-session', turn_id: 'ended-turn', call_id: 'ended-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': endedMetadata};
  recoverReply = recovered;
  recoverHold = new Promise(resolve => { releaseRecovery = resolve; });
  rpcBefore = countOriginal();
  const endedRequest = failure({failUntilRecovered: true});
  await waitFor(() => countOriginal() === rpcBefore + 1, 'the request did not fail first');
  await turnEnded.run({session_id: endedMetadata.session_id, turn_id: endedMetadata.turn_id});
  // However many other turns end meanwhile, this request's turn stays ended.
  for (let index = 0; index < 1100; index++) {
    await turnEnded.run({session_id: 'other-session', turn_id: `other-turn-${index}`});
  }
  releaseRecovery();
  assert.equal((await endedRequest).message, startupFailure);
  recoverHold = undefined;
  assert.equal(countOriginal(), rpcBefore + 1, 'nothing is sent for a turn that has ended');
  globalThis.nodeRepl.requestMeta = {};
  // The same holds when the failure and recovery happen in the turn-cleanup gate before the
  // request: the ended turn is not dispatched and not registered again.
  reset();
  const priorMetadata = {session_id: 'prior-session', turn_id: 'prior-turn', call_id: 'prior-call'};
  const gateMetadata = {session_id: 'gate-session', turn_id: 'gate-turn', call_id: 'gate-call'};
  for (const metadata of [priorMetadata, gateMetadata]) {
    globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': metadata};
    assert.deepEqual(await rpc(), {ok: true});
  }
  globalThis.failTurnEndedMessage = startupFailure;
  globalThis.failTurnEndedCount = 2;  // the prior turn's hook, then the gate's attempt
  await assert.rejects(turnEnded.run({session_id: priorMetadata.session_id, turn_id: priorMetadata.turn_id}));
  recoverReply = recovered;
  recoverHold = new Promise(resolve => { releaseRecovery = resolve; });
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  const gatedRequest = failure();
  await waitFor(() => recoverRequests.length === recoveriesBefore + 1, 'the cleanup gate did not ask for recovery');
  await turnEnded.run({session_id: gateMetadata.session_id, turn_id: gateMetadata.turn_id});
  releaseRecovery();
  assert.equal((await gatedRequest).message, startupFailure);
  recoverHold = undefined;
  assert.equal(countOriginal(), rpcBefore, 'nothing is sent for a turn that ended during the cleanup gate');
  globalThis.failTurnEndedMessage = undefined;
  globalThis.failTurnEndedCount = 0;
  // A request that starts after its turn ended is sent as before; its first attempt never
  // reached the service, so its single retry after a recovery is its only delivery.
  reset();
  recoverReply = recovered;
  rpcBefore = countOriginal();
  assert.deepEqual(await rpc({failUntilRecovered: true}), {ok: true});
  assert.equal(countOriginal(), rpcBefore + 2);
  // That request was registered as before; its turn ends again.
  await turnEnded.run({session_id: gateMetadata.session_id, turn_id: gateMetadata.turn_id});
  globalThis.nodeRepl.requestMeta = {};
  assert.deepEqual(await rpc(), {ok: true}, 'the pending cleanup completes and later requests proceed');

  // And when the turn ends while the retried cleanup gate is still running.
  reset();
  const heldPrior = {session_id: 'held-prior-session', turn_id: 'held-prior-turn', call_id: 'held-prior-call'};
  const heldTurn = {session_id: 'held-session', turn_id: 'held-turn', call_id: 'held-call'};
  for (const metadata of [heldPrior, heldTurn]) {
    globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': metadata};
    assert.deepEqual(await rpc(), {ok: true});
  }
  globalThis.failTurnEndedMessage = startupFailure;
  globalThis.failTurnEndedCount = 2;  // the prior turn's hook, then the gate's first attempt
  await assert.rejects(turnEnded.run({session_id: heldPrior.session_id, turn_id: heldPrior.turn_id}));
  recoverReply = recovered;
  recoverHold = new Promise(resolve => { releaseRecovery = resolve; });
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  const heldRequest = failure();
  await waitFor(() => recoverRequests.length === recoveriesBefore + 1, 'the cleanup gate did not ask for recovery');
  // Hold the retried gate's native turn-ended, then let the recovery answer.
  let releaseGate;
  globalThis.turnEndedGate = new Promise(resolve => { releaseGate = resolve; });
  const heldNativeCount = () => calls.filter(call => call.requestType === 'ComputerUseIPCCodexTurnEndedRequest').length;
  const heldNativeBefore = heldNativeCount();
  releaseRecovery();
  await waitFor(() => heldNativeCount() > heldNativeBefore, 'the retried gate did not start');
  // The turn ends while that retried gate is running.
  const heldEnded = turnEnded.run({session_id: heldTurn.session_id, turn_id: heldTurn.turn_id});
  globalThis.turnEndedGate = undefined;
  releaseGate();
  await heldEnded;
  assert.equal((await heldRequest).message, startupFailure);
  recoverHold = undefined;
  assert.equal(countOriginal(), rpcBefore, 'nothing is sent for a turn that ended during the retried gate');
  globalThis.failTurnEndedMessage = undefined;
  globalThis.nodeRepl.requestMeta = {};
  assert.deepEqual(await rpc(), {ok: true});

  // If that retried gate then fails, the error that led to the recovery still comes back.
  reset();
  const failPrior = {session_id: 'fail-prior-session', turn_id: 'fail-prior-turn', call_id: 'fail-prior-call'};
  const failTurn = {session_id: 'fail-session', turn_id: 'fail-turn', call_id: 'fail-call'};
  for (const metadata of [failPrior, failTurn]) {
    globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': metadata};
    assert.deepEqual(await rpc(), {ok: true});
  }
  globalThis.failTurnEndedMessage = startupFailure;
  globalThis.failTurnEndedCount = 2;
  await assert.rejects(turnEnded.run({session_id: failPrior.session_id, turn_id: failPrior.turn_id}));
  recoverReply = recovered;
  recoverHold = new Promise(resolve => { releaseRecovery = resolve; });
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  const failRequest = failure();
  await waitFor(() => recoverRequests.length === recoveriesBefore + 1, 'the cleanup gate did not ask for recovery');
  let releaseFailGate;
  globalThis.turnEndedGate = new Promise(resolve => { releaseFailGate = resolve; });
  const failNativeCount = () => calls.filter(call => call.requestType === 'ComputerUseIPCCodexTurnEndedRequest').length;
  const failNativeBefore = failNativeCount();
  releaseRecovery();
  await waitFor(() => failNativeCount() > failNativeBefore, 'the retried gate did not start');
  const failEnded = turnEnded.run({session_id: failTurn.session_id, turn_id: failTurn.turn_id}).catch(() => {});
  // Every held and later native turn-ended now fails with another error.
  globalThis.failTurnEndedMessage = 'Some other native failure';
  globalThis.failTurnEndedCount = 10;
  globalThis.turnEndedGate = undefined;
  releaseFailGate();
  await failEnded;
  const failError = await failRequest;
  assert.equal(failError.message, startupFailure, 'the error that led to the recovery, not the gate\'s');
  recoverHold = undefined;
  assert.equal(countOriginal(), rpcBefore);
  globalThis.failTurnEndedMessage = undefined;
  globalThis.failTurnEndedCount = 0;
  globalThis.nodeRepl.requestMeta = {};
  assert.deepEqual(await rpc(), {ok: true});

  // A turn ID can be used again after its turn-ended (a harness that continues the same
  // prompt): without a recovery its later requests are registered as before, so the next
  // turn-ended still reaches the native service.
  reset();
  const reusedTurn = {session_id: 'reused-session', turn_id: 'reused-turn', call_id: 'reused-call'};
  const reusedEnded = () => calls.filter(call => call.requestType === 'ComputerUseIPCCodexTurnEndedRequest' &&
    call.payload?.turnID === reusedTurn.turn_id).length;
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': reusedTurn};
  assert.deepEqual(await rpc(), {ok: true});
  await turnEnded.run({session_id: reusedTurn.session_id, turn_id: reusedTurn.turn_id});
  assert.equal(reusedEnded(), 1);
  assert.deepEqual(await rpc(), {ok: true});
  await turnEnded.run({session_id: reusedTurn.session_id, turn_id: reusedTurn.turn_id});
  assert.equal(reusedEnded(), 2, 'the second turn-ended of a reused turn reaches the native service');
  globalThis.nodeRepl.requestMeta = {};

  // Without a recovery, registration is as on main: the turn is read after the cleanup gate,
  // so a request that waited while its turn ended and the next turn began registers the next.
  reset();
  const parityPrior = {session_id: 'parity-prior-session', turn_id: 'parity-prior-turn', call_id: 'parity-prior-call'};
  const parityOld = {session_id: 'parity-old-session', turn_id: 'parity-old-turn', call_id: 'parity-old-call'};
  const parityNew = {session_id: 'parity-new-session', turn_id: 'parity-new-turn', call_id: 'parity-new-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': parityPrior};
  assert.deepEqual(await rpc(), {ok: true});
  let releaseParity;
  globalThis.turnEndedGate = new Promise(resolve => { releaseParity = resolve; });
  const parityPriorEnded = turnEnded.run({session_id: parityPrior.session_id, turn_id: parityPrior.turn_id});
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': parityOld};
  const parityRequest = rpc();
  await turnEnded.run({session_id: parityOld.session_id, turn_id: parityOld.turn_id}).catch(() => {});
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': parityNew};
  globalThis.turnEndedGate = undefined;
  releaseParity();
  await parityPriorEnded;
  assert.deepEqual(await parityRequest, {ok: true});
  const parityNewEnded = () => calls.filter(call => call.requestType === 'ComputerUseIPCCodexTurnEndedRequest' &&
    call.payload?.turnID === parityNew.turn_id).length;
  await turnEnded.run({session_id: parityNew.session_id, turn_id: parityNew.turn_id});
  assert.equal(parityNewEnded(), 1, 'the request registered the turn current after the gate, as on main');
  globalThis.nodeRepl.requestMeta = {};

  // A request whose turn ended while it waited in the gate (no recovery) is registered as on
  // main; a later request then recovers and is retried once like any other.
  reset();
  const racePrior = {session_id: 'race-prior-session', turn_id: 'race-prior-turn', call_id: 'race-prior-call'};
  const raceTurn = {session_id: 'race-session', turn_id: 'race-turn', call_id: 'race-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': racePrior};
  assert.deepEqual(await rpc(), {ok: true});
  let releaseRace;
  globalThis.turnEndedGate = new Promise(resolve => { releaseRace = resolve; });
  const racePriorEnded = turnEnded.run({session_id: racePrior.session_id, turn_id: racePrior.turn_id});
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': raceTurn};
  const raceRequest = rpc();
  await turnEnded.run({session_id: raceTurn.session_id, turn_id: raceTurn.turn_id}).catch(() => {});
  globalThis.turnEndedGate = undefined;
  releaseRace();
  await racePriorEnded;
  assert.deepEqual(await raceRequest, {ok: true});
  recoverReply = recovered;
  rpcBefore = countOriginal();
  assert.deepEqual(await rpc({failUntilRecovered: true}), {ok: true});
  assert.equal(countOriginal(), rpcBefore + 2, 'a later request is retried once, as any request');
  await turnEnded.run({session_id: raceTurn.session_id, turn_id: raceTurn.turn_id});
  globalThis.nodeRepl.requestMeta = {};

  // A turn end the hook rejects (missing IDs) still counts as a turn end: no retry follows.
  reset();
  recoverReply = recovered;
  recoverHold = new Promise(resolve => { releaseRecovery = resolve; });
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  const missingRequest = failure({failUntilRecovered: true});
  await waitFor(() => recoverRequests.length === recoveriesBefore + 1, 'the request did not ask for recovery');
  await assert.rejects(turnEnded.run({session_id: '', turn_id: ''}));
  releaseRecovery();
  assert.equal((await missingRequest).message, startupFailure);
  recoverHold = undefined;
  assert.equal(countOriginal(), rpcBefore + 1, 'nothing is sent again after any turn end');
  // Nor does a turn end with no event object at all.
  reset();
  recoverReply = recovered;
  recoverHold = new Promise(resolve => { releaseRecovery = resolve; });
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  const noEventRequest = failure({failUntilRecovered: true});
  await waitFor(() => recoverRequests.length === recoveriesBefore + 1, 'the request did not ask for recovery');
  await assert.rejects(turnEnded.run(undefined));
  releaseRecovery();
  assert.equal((await noEventRequest).message, startupFailure);
  recoverHold = undefined;
  assert.equal(countOriginal(), rpcBefore + 1);

  // A turn that is still active is retried, after the pending turn cleanup.
  reset();
  const activeMetadata = {session_id: 'active-session', turn_id: 'active-turn', call_id: 'active-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': activeMetadata};
  rpcBefore = countOriginal();
  assert.deepEqual(await rpc({failUntilRecovered: true}), {ok: true});
  assert.equal(countOriginal(), rpcBefore + 2);
  await turnEnded.run({session_id: activeMetadata.session_id, turn_id: activeMetadata.turn_id});
  globalThis.nodeRepl.requestMeta = {};

  // An unreachable host, or none configured, leaves the original error, immediately.
  reset();
  recoverDelayMs = 0;
  const lifetimeAddress = globalThis.nodeRepl.env.LCU_MAC_LIFETIME_SOCKET;
  for (const address of [join(root, 'missing.sock'), undefined]) {
    globalThis.nodeRepl.env.LCU_MAC_LIFETIME_SOCKET = address;
    rpcBefore = countOriginal();
    assert.equal((await failure({fail: startupFailure})).message, startupFailure);
    assert.equal(countOriginal(), rpcBefore + 1);
  }
  globalThis.nodeRepl.env.LCU_MAC_LIFETIME_SOCKET = lifetimeAddress;

  // A host that never answers delays the original error by a bounded time only, and the
  // configured bound can only lower the default.
  recoverReply = undefined;
  globalThis.nodeRepl.env.LCU_MAC_RECOVER_TIMEOUT_MS = '400';
  rpcBefore = countOriginal();
  const hangStarted = Date.now();
  assert.equal((await failure({fail: startupFailure})).message, startupFailure);
  const hangMs = Date.now() - hangStarted;
  assert.ok(hangMs >= 350 && hangMs < 2_000, `recovery wait was ${hangMs} ms`);
  assert.equal(countOriginal(), rpcBefore + 1);
  // Giving up closes the connection, which is what tells the host to signal nothing.
  await waitFor(() => recoverClosed.length === recoverRequests.length, 'the client closes a recovery it gave up on');
  globalThis.nodeRepl.env.LCU_MAC_RECOVER_TIMEOUT_MS = undefined;

  // A frozen error object is still thrown unchanged when nothing was recovered.
  reset();
  recoverReply = notRecovered;
  assert.equal((await failure({fail: startupFailure, freeze: true})).message, startupFailure);

  // A lifetime connection that never settles cannot hold later requests behind its cleanup.
  const hangMetadata = {session_id: 'hang-session', turn_id: 'hang-turn', call_id: 'hang-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': hangMetadata};
  assert.deepEqual(await rpc(), {ok: true});
  const realCreateConnection = globalThis.nodeRepl.nativePipe.createConnection;
  globalThis.nodeRepl.nativePipe.createConnection = () => new Promise(() => {});
  // The hook waits only for the native step; the command step behind it gives up on the
  // connection, so the next request is not held behind it.
  await turnEnded.run({session_id: hangMetadata.session_id, turn_id: hangMetadata.turn_id});
  globalThis.nodeRepl.requestMeta = {};
  const cleanupStarted = Date.now();
  assert.deepEqual(await rpc(), {ok: true}, 'the request proceeds after the bounded connection attempt');
  assert.ok(Date.now() - cleanupStarted < 12_000);
  globalThis.nodeRepl.nativePipe.createConnection = realCreateConnection;

  // A native cleanup step that never settles is abandoned after a hard bound, so the request
  // behind it is not held forever; the cleanup is retried by the next request.
  const stuckMetadata = {session_id: 'stuck-session', turn_id: 'stuck-turn', call_id: 'stuck-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': stuckMetadata};
  assert.deepEqual(await rpc(), {ok: true});
  globalThis.nodeRepl.env.LCU_MAC_CLEANUP_STEP_TIMEOUT_MS = '300';
  globalThis.turnEndedGate = new Promise(() => {});
  const stuckStarted = Date.now();
  await assert.rejects(turnEnded.run({session_id: stuckMetadata.session_id, turn_id: stuckMetadata.turn_id}),
    /timed out after 300 ms/);
  assert.ok(Date.now() - stuckStarted < 3_000);
  globalThis.turnEndedGate = undefined;
  globalThis.nodeRepl.env.LCU_MAC_CLEANUP_STEP_TIMEOUT_MS = undefined;
  globalThis.nodeRepl.requestMeta = {};
  assert.deepEqual(await rpc(), {ok: true}, 'the abandoned cleanup is retried and the request proceeds');

  // Retried turn cleanup uses the same pipe and fails the same way: a recovery makes the
  // cleanup retry and the request proceed; without one the original error is thrown.
  const cleanupMetadata = {session_id: 'cleanup-session', turn_id: 'cleanup-turn', call_id: 'cleanup-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': cleanupMetadata};
  assert.deepEqual(await rpc(), {ok: true});
  globalThis.failTurnEndedMessage = startupFailure;
  globalThis.failTurnEndedCount = 2;
  await assert.rejects(turnEnded.run({session_id: cleanupMetadata.session_id,
    turn_id: cleanupMetadata.turn_id}), error => error.message === startupFailure);
  reset();
  recoverReply = notRecovered;
  recoveriesBefore = recoverRequests.length;
  globalThis.nodeRepl.requestMeta = {};
  await assert.rejects(rpc(), error => error.message === startupFailure);
  assert.equal(globalThis.failTurnEndedCount, 0, 'the failing cleanup was retried before the request failed');
  assert.equal(recoverRequests.length, recoveriesBefore + 1);
  // The cleanup attempt fails once; the recovery lets its single retry through.
  globalThis.failTurnEndedCount = 1;
  recoverReply = recovered;
  recoveriesBefore = recoverRequests.length;
  rpcBefore = countOriginal();
  assert.deepEqual(await rpc(), {ok: true});
  assert.equal(recoverRequests.length, recoveriesBefore + 1);
  assert.equal(countOriginal(), rpcBefore + 1);
  globalThis.failTurnEndedMessage = undefined;
  globalThis.failTurnEndedCount = 0;

  const boundaryTurns = [];
  for (let index = 0; index < 127; index++) {
    const context = {session_id: `bounded-session-${index}`,
      turn_id: `bounded-turn-${index}`, call_id: `bounded-call-${index}`};
    boundaryTurns.push(context);
    globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': context};
    await handleRpc({type: 'execute', method: 'list_apps', args: []});
  }
  const rpcCountAtCapacity = globalThis.originalRpcCount;
  const overflow = {session_id: 'bounded-overflow-session',
    turn_id: 'bounded-overflow-turn', call_id: 'bounded-overflow-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': overflow};
  await assert.rejects(handleRpc({type: 'execute', method: 'list_apps', args: []}),
    /Too many active macOS turn metadata contexts/);
  assert.equal(globalThis.originalRpcCount, rpcCountAtCapacity,
    'a new Sky request must not dispatch if its cleanup metadata cannot be retained');
  await turnEnded.run({session_id: boundaryTurns[0].session_id,
    turn_id: boundaryTurns[0].turn_id});
  await handleRpc({type: 'execute', method: 'list_apps', args: []});
  assert.equal(globalThis.originalRpcCount, rpcCountAtCapacity + 1,
    'a new Sky request should dispatch after turn cleanup frees a metadata slot');

  for (const raw of [undefined, '{bad metadata']) {
    globalThis.nodeRepl.requestMeta = raw === undefined ? {} : {'x-codex-turn-metadata': raw};
    assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
  }
  console.log('macOS trusted control dispatch checks passed');
} finally {
  serviceSocket?.destroy();
  await new Promise(resolve => controlServer.close(resolve));
  await new Promise(resolve => lifetimeServer.close(resolve));
  await rm(root, {recursive: true, force: true});
}
