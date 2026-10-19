// Forward the original Sky service unchanged except for type_text lines with
// characters the native keyboard path drops, which go to the original
// policy-checked paste, and relay its original lifecycle hook to the signed
// macOS client through an LCU-owned, short-lived socket.
import {pathToFileURL} from 'node:url';
import {Buffer} from 'node:buffer';

let original;
let controlClient;
let registered = false;
const pendingCleanup = new Map();
let cleanupInFlight;
let controlConnection;
let controlConnecting;
let controlUnavailable = false;
let controlBuffer = Buffer.alloc(0);
const activeContexts = new Map();
const CONTROL_DEADLINE_MS = 40_000;
// The original worker uses its 15s native-control default for status and Stop.
const CONTROL_STATUS_TIMEOUT_SECONDS = 15;
const CONTROL_STOP_TIMEOUT_SECONDS = 15;
// Bound extra original-policy lookups while preserving the full Stop timeout.
const CONTROL_SELECTOR_RESOLUTION_BUDGET_MS = 5_000;
const TURN_METADATA_LIMIT = 128;
// The original node_repl host waits only 5 s for turn-ended handlers and then
// fails the turn. Return before that; slower cleanup continues in the
// background and finishPendingCleanup() gates the next Sky request on it.
const TURN_CLEANUP_HOOK_TIMEOUT_MS = 4_000;
// How long to wait for the private lifetime host: its TURN_ENDED_CLI_TIMEOUT_SECONDS
// (10 s, lcu/macos_host.mjs) plus 2 s for the socket round trip. Keep it above the host.
export const LIFETIME_SIGNAL_TIMEOUT_MS = 12_000;
// The original command is retried once, at the next Sky request, then dropped.
const CLI_CLEANUP_ATTEMPTS = 2;
const TURN_ENDED_TIMEOUT_SECONDS = 15;
const turnMetadata = new Map();
// Turn-ended hooks run so far. A request that saw any turn end (Stop or Interrupt) after it
// started is never retried, registered or sent after a stale service recovery.
let turnsEnded = 0;

function lifetimeSignal(runtime, session_id, turn_id) {
  const address = runtime.env.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    throw Error('Original macOS native-pipe lifetime channel is unavailable');
  }
  // Bound the connection itself too: a connection that never settles must not hold every
  // later request behind this cleanup.
  const connecting = Promise.resolve().then(() => runtime.nativePipe.createConnection(address));
  let connectTimer;
  const connectDeadline = new Promise((_, reject) => {
    connectTimer = setTimeout(() => {
      connecting.then(late => { try { late.end(); } catch {} }, () => {});
      reject(Error('macOS native turn cleanup connection timed out'));
    }, 4000);
  });
  return Promise.race([connecting, connectDeadline]).finally(() => clearTimeout(connectTimer)).then(socket => new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => finish(Error('macOS native turn cleanup timed out')), LIFETIME_SIGNAL_TIMEOUT_MS);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.end();
      if (error) reject(error); else resolve(result);
    }
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 4096) return finish(Error('macOS native cleanup response is too large'));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, newline).toString('utf8'));
        if (!result || result.notified !== true) {
          throw Error(result?.error || 'Original macOS turn-ended command failed');
        }
        finish(null, true);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(Error('macOS native cleanup channel closed')));
    socket.write(Buffer.from(JSON.stringify({session_id, turn_id}) + '\n'));
  }));
}

// Tell the private host that a turn is open, so it can still end the turn when this worker is gone before the
// turn's end (js_reset, server exit). Best effort: never waits, never throws.
function announceTurn(runtime, session_id, turn_id) {
  const address = runtime?.env?.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') return;
  Promise.resolve().then(() => runtime.nativePipe.createConnection(address)).then(socket => {
    const timer = setTimeout(() => { try { socket.end(); } catch {} }, 2000);
    const done = () => { clearTimeout(timer); try { socket.end(); } catch {} };
    socket.on('data', done);
    socket.on('error', done);
    socket.on('close', () => clearTimeout(timer));
    socket.write(Buffer.from(JSON.stringify({type: 'turn', session_id, turn_id}) + '\n'));
  }).catch(() => {});
}

// The exact message of the original transport error; a longer message that merely contains
// these words (a validation or approval error) is not a native pipe failure.
const NATIVE_PIPE_FAILURE = 'Sky Computer Use native pipe startup failed';
// Upper bound on what a failed request waits for the host's recovery attempt: the host
// bounds its own checks and the service's exit to under this.
const RECOVER_TIMEOUT_MS = 15_000;
let recovering;

// Ask the private host to recover from a stale Computer Use service. It stops one only
// when it proves that service is stale, holds the connection and is ours to stop; it
// answers `recovered: true` once that service has exited. Resolves to true only then.
// Never rejects, and never waits longer than RECOVER_TIMEOUT_MS. Giving up closes the
// connection, and the host signals nothing once it sees that.
function askHostToRecover(runtime) {
  const address = runtime?.env?.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    return Promise.resolve(false);
  }
  // A shorter bound may be configured (tests); the wait never exceeds RECOVER_TIMEOUT_MS.
  const configured = Number(runtime.env.LCU_MAC_RECOVER_TIMEOUT_MS);
  const timeoutMs = configured > 0 ? Math.min(configured, RECOVER_TIMEOUT_MS) : RECOVER_TIMEOUT_MS;
  return new Promise(resolve => {
    let socket;
    let finished = false;
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(recovered) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.end(); } catch {}
      resolve(recovered === true);
    }
    Promise.resolve().then(() => runtime.nativePipe.createConnection(address)).then(connection => {
      if (finished) {
        try { connection.end(); } catch {}
        return;
      }
      socket = connection;
      socket.on('data', chunk => {
        data = Buffer.concat([data, Buffer.from(chunk)]);
        if (data.length > 65536) return finish(false);
        const newline = data.indexOf(10);
        if (newline < 0) return;
        try {
          const result = JSON.parse(data.subarray(0, newline).toString('utf8'));
          finish(result?.ok === true && result.recovered === true);
        } catch { finish(false); }
      });
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
      socket.write(Buffer.from(JSON.stringify({type: 'recover'}) + '\n'));
    }).catch(() => finish(false));
  });
}

// One recovery at a time: concurrent failures share it.
function recoverOnce(runtime) {
  recovering ??= askHostToRecover(runtime).finally(() => { recovering = undefined; });
  return recovering;
}

// Run `attempt`. When it fails with a native pipe startup failure, the host recovered from a
// provably stale service and `beforeRetry` still allows it, run it once more. In every other
// case the original error is thrown unchanged, and a failure of the single retry (or of
// `beforeRetry`) is that failure's own error.
async function withStaleServiceRecovery(runtime, attempt, beforeRetry = async () => true) {
  try {
    return await attempt();
  } catch (error) {
    let recovered = false;
    try {
      recovered = typeof error?.message === 'string' && error.message === NATIVE_PIPE_FAILURE &&
        await recoverOnce(runtime);
    } catch {}
    if (!recovered || !(await beforeRetry(error))) throw error;
  }
  return attempt();
}

function register() {
  if (registered) return;
  const runtime = globalThis.nodeRepl;
  if (typeof runtime?.addTurnEndedHandler !== 'function') {
    throw Error('Original node_repl turn-ended hook is unavailable');
  }
  runtime.addTurnEndedHandler({timeoutMs: TURN_CLEANUP_HOOK_TIMEOUT_MS, run: async event => {
    // Counted first, so even a turn end rejected below blocks recovery retries.
    turnsEnded++;
    const {session_id, turn_id} = event ?? {};
    if (typeof session_id !== 'string' || !session_id.trim() ||
        typeof turn_id !== 'string' || !turn_id.trim()) {
      // An unattributed turn end stops every segmented request.
      for (const listener of turnEndListeners) listener(undefined);
      throw Error('Original node_repl turn IDs are missing');
    }
    endControlTurn(session_id, turn_id);
    const key = JSON.stringify([session_id, turn_id]);
    for (const listener of turnEndListeners) listener(key);
    const item = pendingCleanup.get(key) ?? {
      key, session_id, turn_id,
      metadata: turnMetadata.get(key),
      nativeNotified: false,
      cliFailures: 0,
    };
    pendingCleanup.set(key, item);
    turnMetadata.delete(key);
    // Wait only for the native step. The original command takes about 5 s, so it
    // finishes in the background; the next Sky request waits for it.
    await nativeCleanup(item);
    finishPendingCleanup().catch(() => {});
  }});
  registered = true;
}

function readTurnMetadata(runtime) {
  try {
    const raw = runtime.requestMeta?.['x-codex-turn-metadata'];
    let metadata = raw;
    if (raw instanceof Uint8Array) metadata = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (typeof raw === 'string') metadata = JSON.parse(raw);
    if (!metadata || typeof metadata !== 'object' ||
        typeof metadata.session_id !== 'string' || !metadata.session_id.trim() ||
        typeof metadata.turn_id !== 'string' || !metadata.turn_id.trim()) return undefined;
    return JSON.parse(JSON.stringify(metadata));
  } catch { return undefined; }
}

function writeControl(message) {
  if (!controlConnection) return;
  controlConnection.write(Buffer.from(JSON.stringify(message) + '\n'));
}

function controlContext(runtime, request) {
  try {
    const metadata = readTurnMetadata(runtime);
    if (!metadata) return undefined;
    let app;
    if (request?.type === 'execute' && Array.isArray(request.args)) {
      const argument = request.args[0];
      if (typeof argument === 'string' && request.method === 'get_app_state') app = argument;
      else if (argument && typeof argument.app === 'string') app = argument.app;
    }
    return {metadata, session_id: metadata.session_id, turn_id: metadata.turn_id, app};
  } catch { return undefined; }
}

function endControlTurn(session_id, turn_id) {
  for (const [token, item] of activeContexts) {
    if (item.session_id === session_id && item.turn_id === turn_id) {
      activeContexts.delete(token);
      writeControl({type: 'context-ended', token});
    }
  }
}

async function invokeOriginalControl(request, context) {
  const matches = [...activeContexts.values()].filter(item =>
    item.session_id === request.session_id && item.turn_id === request.turn_id);
  if (!context || !matches.length || !matches.some(item => item.metadata === context.metadata)) {
    throw Error('The requested session and turn are not active in the trusted Sky runtime');
  }
  if (request.type !== 'status' && request.type !== 'stop') {
    throw Error('Unsupported original macOS control request');
  }
  const deadline = request.deadline_unix_ms;
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() ||
      deadline > Date.now() + CONTROL_DEADLINE_MS) {
    throw Error('The macOS control request has an invalid or expired deadline');
  }
  const reserveAfterStatusMs = CONTROL_SELECTOR_RESOLUTION_BUDGET_MS +
    (request.type === 'stop' ? CONTROL_STOP_TIMEOUT_SECONDS * 1000 : 0);
  const initialBudgetMs = deadline - Date.now();
  if (initialBudgetMs <= reserveAfterStatusMs) {
    throw Error('The macOS control request expired before its status check could begin');
  }
  const {MacComputerUseClient} = await import(pathToFileURL(
    globalThis.nodeRepl.env.LCU_MAC_SKY_CLIENT_PATH).href);
  controlClient ??= new MacComputerUseClient();
  const metadata = context.metadata;
  const options = {codexMetadata: metadata,
    timeoutSeconds: Math.min(CONTROL_STATUS_TIMEOUT_SECONDS,
      Math.floor((initialBudgetMs - reserveAfterStatusMs) / 1000))};
  const status = await controlClient.request(
    'ComputerUseIPCCodexStatusItemMenuStateRequest', {}, options);
  const activeApplications = status?.computerUse?.activeApplications;
  if (!Array.isArray(activeApplications) || activeApplications.some(app =>
      !app || typeof app.bundleIdentifier !== 'string')) {
    throw Error('Original macOS status returned an invalid active application list');
  }
  const targetedApps = new Map();
  const resolutionDeadline = Math.min(deadline -
    (request.type === 'stop' ? CONTROL_STOP_TIMEOUT_SECONDS * 1000 : 0),
  Date.now() + CONTROL_SELECTOR_RESOLUTION_BUDGET_MS);
  for (const item of matches) {
    if (!item.app) continue;
    if (activeApplications.some(app => app.bundleIdentifier === item.app)) {
      targetedApps.set(item, item.app);
      continue;
    }
    const remainingSeconds = Math.floor((resolutionDeadline - Date.now()) / 1000);
    if (remainingSeconds <= 0) break;
    try {
      const policy = await controlClient.getAppPolicy(item.app, {
        codexMetadata: item.metadata,
        timeoutSeconds: Math.min(CONTROL_STATUS_TIMEOUT_SECONDS, remainingSeconds),
      });
      const bundleIdentifier = policy?.target?.bundleIdentifier;
      if (policy?.decision === 'allowed' &&
          typeof bundleIdentifier === 'string' && bundleIdentifier.trim()) {
        targetedApps.set(item, bundleIdentifier);
      }
    } catch {}
  }
  const targetBundleIdentifiers = new Set(targetedApps.values());
  const visibleApplications = activeApplications.filter(app =>
    targetBundleIdentifiers.has(app.bundleIdentifier));
  if (request.type === 'status') return {computerUse: {
    ...status.computerUse, activeApplications: visibleApplications},
    computerHistory: status.computerHistory};
  if (typeof request.app !== 'string' ||
      !targetBundleIdentifiers.has(request.app) ||
      !visibleApplications.some(app => app.bundleIdentifier === request.app)) {
    throw Error('The selected application is not targeted by an active original computer-use call');
  }
  const selectedApp = visibleApplications.find(app => app.bundleIdentifier === request.app);
  if (typeof selectedApp?.id !== 'string' || !selectedApp.id.trim()) {
    throw Error('Original macOS status did not provide the selected application ID');
  }
  const selectedContext = matches.find(item => targetedApps.get(item) === request.app &&
    activeContexts.get(JSON.stringify([item.session_id, item.turn_id, item.app])) === item);
  if (!selectedContext) {
    throw Error('The original LCU turn ended before Stop could be sent');
  }
  const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
  if (remainingSeconds < 1) {
    throw Error('The macOS Stop request expired before the original Stop could be sent');
  }
  await controlClient.request('ComputerUseIPCAppStopRequest', {app: selectedApp.id}, {
    codexMetadata: selectedContext.metadata,
    timeoutSeconds: Math.min(CONTROL_STOP_TIMEOUT_SECONDS, remainingSeconds),
  });
  return {accepted: true, applicationId: request.app};
}

async function processControlRequest(request) {
  let response;
  try {
    response = {ok: true, result: await invokeOriginalControl(request,
      [...activeContexts.values()].find(item => item.session_id === request.session_id &&
        item.turn_id === request.turn_id))};
  } catch (error) {
    response = {ok: false, error: String(error?.message ?? error).slice(0, 512)};
  }
  writeControl({type: 'result', request_id: request.request_id, response});
}

function startControlChannel(runtime) {
  const address = runtime.env.LCU_MAC_CONTROL_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    return Promise.resolve(false);
  }
  if (controlUnavailable) return Promise.resolve(false);
  if (controlConnection) return Promise.resolve(true);
  if (controlConnecting) return controlConnecting;
  const connecting = Promise.resolve().then(() => runtime.nativePipe.createConnection(address));
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('macOS control connection timed out')), 2000);
  });
  controlConnecting = Promise.race([connecting, deadline]).then(connection => {
    clearTimeout(timer);
    controlConnection = connection;
    controlBuffer = Buffer.alloc(0);
    connection.on('data', chunk => {
      controlBuffer = Buffer.concat([controlBuffer, Buffer.from(chunk)]);
      if (controlBuffer.length > 65536) {
        connection.end();
        controlConnection = undefined;
        return;
      }
      for (;;) {
        const newline = controlBuffer.indexOf(10);
        if (newline < 0) break;
        const line = controlBuffer.subarray(0, newline);
        controlBuffer = controlBuffer.subarray(newline + 1);
        try { void processControlRequest(JSON.parse(line.toString('utf8'))); }
        catch (error) { console.error(`LCU macOS control request failed: ${error}`); }
      }
    });
    connection.on('error', () => {
      if (controlConnection === connection) {
        controlConnection = undefined;
        activeContexts.clear();
        controlBuffer = Buffer.alloc(0);
      }
    });
    connection.on('close', () => {
      if (controlConnection === connection) {
        controlConnection = undefined;
        activeContexts.clear();
        controlBuffer = Buffer.alloc(0);
      }
    });
    writeControl({type: 'service'});
    return true;
  }).catch(error => {
    clearTimeout(timer);
    controlUnavailable = true;
    connecting.then(connection => connection.end(), () => {});
    console.error(`LCU macOS control channel unavailable: ${error}`);
    return false;
  }).finally(() => { controlConnecting = undefined; });
  return controlConnecting;
}

const SLOW_CLEANUP_STEP_MS = 1_000;
// A cleanup step that never settles (an original transport call stuck in LaunchServices)
// must not hold every later request behind it. A lower bound may be configured (tests).
const CLEANUP_STEP_HARD_TIMEOUT_MS = 20_000;

// Report which cleanup step is slow so a host "turn-ended handlers timed out"
// can be attributed to native IPC or the CLI helper. Only a step the hook waits
// for needs the watchdog.
async function timedCleanupStep(step, run, {hookWaits = false} = {}) {
  const started = Date.now();
  // The host gives up on the hook at about 5 s, so name a step still running then.
  const watchdog = hookWaits ? setTimeout(() => {
    console.error(`LCU macOS turn cleanup step "${step}" is still running after ${Date.now() - started} ms`);
  }, TURN_CLEANUP_HOOK_TIMEOUT_MS) : undefined;
  let hardTimer;
  const hardLimit = Number(globalThis.nodeRepl?.env?.LCU_MAC_CLEANUP_STEP_TIMEOUT_MS);
  const hardMs = hardLimit > 0 ? Math.min(hardLimit, CLEANUP_STEP_HARD_TIMEOUT_MS) : CLEANUP_STEP_HARD_TIMEOUT_MS;
  try {
    return await Promise.race([run(), new Promise((_, reject) => {
      hardTimer = setTimeout(() => reject(Error(`macOS turn cleanup step "${step}" timed out after ${hardMs} ms`)), hardMs);
    })]);
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(watchdog);
    const ms = Date.now() - started;
    if (ms >= SLOW_CLEANUP_STEP_MS) {
      console.error(`LCU macOS turn cleanup step "${step}" took ${ms} ms`);
    }
  }
}

// Acknowledge the turn end through the original native IPC. Concurrent callers
// (the hook and the next Sky request) share one attempt per item.
function nativeCleanup(item) {
  if (!item.metadata || item.nativeNotified) return Promise.resolve();
  item.nativeAttempt ??= timedCleanupStep('native IPC turn-ended', async () => {
    // Include the first, cold import of the client in the step's timing.
    const {MacComputerUseClient} = await import(pathToFileURL(
      globalThis.nodeRepl.env.LCU_MAC_SKY_CLIENT_PATH).href);
    controlClient ??= new MacComputerUseClient();
    return controlClient.request('ComputerUseIPCCodexTurnEndedRequest', {
      threadID: item.session_id,
      turnID: item.turn_id,
    }, {codexMetadata: item.metadata, timeoutSeconds: TURN_ENDED_TIMEOUT_SECONDS});
  }, {hookWaits: true}).then(() => { item.nativeNotified = true; })
    .finally(() => { item.nativeAttempt = undefined; });
  return item.nativeAttempt;
}

// Run the original CLI command once. A failure never throws: the item is kept
// for one retry, then dropped, because the native step was already acknowledged
// and a broken helper must not block computer use.
async function cliCleanup(item) {
  const started = Date.now();
  try {
    await timedCleanupStep('CLI turn-ended', () =>
      lifetimeSignal(globalThis.nodeRepl, item.session_id, item.turn_id));
    pendingCleanup.delete(item.key);
  } catch (error) {
    item.cliFailures += 1;
    const ms = Date.now() - started;
    const where = `${item.session_id}/${item.turn_id}`;
    const reason = String(error?.message ?? error).slice(0, 256);
    if (item.cliFailures < CLI_CLEANUP_ATTEMPTS) {
      console.error(`LCU macOS turn cleanup: original turn-ended command failed for ${where} after ${ms} ms (${reason}); retrying once at the next Sky request`);
      return;
    }
    pendingCleanup.delete(item.key);
    const native = item.metadata ? 'native turn-ended was acknowledged'
      : 'no native turn-ended was needed';
    console.error(`LCU macOS turn cleanup: original turn-ended command failed for ${where} after ${ms} ms; ${native}; continuing`);
  }
}

async function runCleanup(retryFailed) {
  const attempted = new Set();
  let nativeFailure;
  for (;;) {
    // Re-scan so a turn that ends while this runs is picked up. Only a Sky
    // request retries a command that already failed once.
    const item = [...pendingCleanup.values()].find(candidate =>
      !attempted.has(candidate) && (retryFailed || candidate.cliFailures === 0));
    if (!item) break;
    attempted.add(item);
    try { await nativeCleanup(item); }
    catch (error) { nativeFailure ??= error; continue; }
    await cliCleanup(item);
  }
  if (nativeFailure) throw nativeFailure;
}

// One run at a time. The turn-ended hook starts a background run; a Sky request
// waits for it and then runs again with retryFailed to retry failed commands.
function finishPendingCleanup({retryFailed = false} = {}) {
  // The original runtime can report MCP success after a hook fails. Retain
  // native cleanup until its host acknowledges it and retry before more actions.
  const current = cleanupInFlight;
  if (current && (current.retryFailed || !retryFailed)) return current.promise;
  const run = {retryFailed};
  run.promise = (current ? current.promise.catch(() => {}) : Promise.resolve())
    .then(() => runCleanup(retryFailed))
    .finally(() => { if (cleanupInFlight === run) cleanupInFlight = undefined; });
  cleanupInFlight = run;
  return run.promise;
}

// A turn can end while the run being awaited is finishing, so recheck that no
// native acknowledgement is outstanding before dispatching.
async function gateOnCleanup() {
  do {
    await finishPendingCleanup({retryFailed: true});
  } while ([...pendingCleanup.values()].some(item => item.metadata && !item.nativeNotified));
}

// The original macOS type_text types each character as one key of the active
// layout and silently drops characters it has no key for (Korean, emoji, ñ on
// AZERTY; openai/codex#27494). Split such text at control characters: control
// runs (Return, Tab, CRLF) stay original type_text so they act as keys, and
// each chunk between them goes whole to the original paste as plain text if
// it has a code point above 127, else to type_text. A grapheme cluster never
// spans a control character, so no character is split. Lone surrogates are
// passed on unchanged, as the original would receive them. Returns undefined
// when the request is not adapted.
function unicodeTextSegments(request) {
  if (request?.type !== 'execute' || request.method !== 'type_text' ||
      !Array.isArray(request.args) || request.args.length < 1) return undefined;
  const input = request.args[0];
  if (!input || typeof input !== 'object') return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  // Leave invalid accessor inputs to the original app-policy validator; never
  // evaluate an accessor while adapting a request in the trusted worker.
  if (Object.values(descriptors).some(property => !('value' in property))) return undefined;
  const text = descriptors.text?.value;
  if (typeof text !== 'string' || !/[^\0-\x7f]/.test(text)) return undefined;
  const runs = [];
  for (const chunk of text.split(/([\x00-\x1f\x7f]+)/)) {
    if (!chunk) continue;
    const paste = /[^\0-\x7f]/.test(chunk);
    // Adjacent typed chunks (a line and the Return after it) are one type_text.
    if (!paste && runs.at(-1)?.paste === false) runs.at(-1).text += chunk;
    else runs.push({paste, text: chunk});
  }
  // Each segment keeps the caller's descriptors and any further arguments with
  // only text replaced (and the plain-text format added for paste); the
  // caller's request is unchanged.
  return runs.map(({paste, text}) => {
    const segment = {...descriptors, text: {...descriptors.text, value: text}};
    if (paste) segment.format = {value: 'text', enumerable: true};
    return {...request, method: paste ? 'paste' : 'type_text',
      args: [Object.defineProperties({}, segment), ...request.args.slice(1)]};
  });
}

// Segmented requests run one at a time, so two of them never interleave.
let segmentQueue = Promise.resolve();
const turnEndListeners = new Set();

export async function handleRpc(request) {
  register();
  const runtime = globalThis.nodeRepl;
  // After a recovery, the request is retried, registered and sent only while no turn has
  // ended since it started; otherwise the error that led to the recovery is returned.
  const startedAt = turnsEnded;
  const turnsActive = () => turnsEnded === startedAt;
  const state = {recoveryError: undefined, resent: false};
  // Turns that ended since a segmented request started, recorded from the start so
  // its own turn's end is seen whenever it happens.
  const segments = unicodeTextSegments(request);
  const endedTurns = new Set();
  const listener = key => endedTurns.add(key);
  if (segments) turnEndListeners.add(listener);
  const retryIfActive = async error => {
    // Each recovery restarts "nothing sent since": only a send after it sets `resent` again.
    state.recoveryError = error;
    state.resent = false;
    return turnsActive();
  };
  try {
    // Retried turn cleanup talks to the same native pipe and fails the same way.
    await withStaleServiceRecovery(runtime, gateOnCleanup, retryIfActive);
    original ??= import(pathToFileURL(runtime.env.LCU_MAC_SKY_SERVICE_PATH).href);
    // Registration is as before, except that nothing is registered after a recovery that a
    // turn end followed.
    const blocked = () => Boolean(state.recoveryError) && !turnsActive();
    const metadata = blocked() ? undefined : readTurnMetadata(runtime);
    if (metadata) {
      const key = JSON.stringify([metadata.session_id, metadata.turn_id]);
      if (!turnMetadata.has(key) && turnMetadata.size >= TURN_METADATA_LIMIT) {
        throw Error('Too many active macOS turn metadata contexts; refusing a new Sky request until turn cleanup completes');
      }
      if (!turnMetadata.has(key)) announceTurn(runtime, metadata.session_id, metadata.turn_id);
      turnMetadata.set(key, metadata);
    }
    const context = blocked() ? undefined : controlContext(runtime, request);
    const controlReady = await startControlChannel(runtime);
    if (context && controlReady && !blocked()) {
      const token = JSON.stringify([context.session_id, context.turn_id, context.app]);
      if (context.app && (activeContexts.has(token) || activeContexts.size < 128)) {
        activeContexts.set(token, context);
        writeControl({type: 'context', token, session_id: context.session_id,
          turn_id: context.turn_id, app: context.app});
      }
    }
    const service = await original;
    // Checked with no wait before the dispatch below.
    if (blocked()) throw state.recoveryError;
    // The retry, like any request, first waits for pending turn cleanup.
    const dispatch = segment => withStaleServiceRecovery(runtime, () => {
      if (state.recoveryError) state.resent = true;
      return service.handleRpc(segment);
    }, async error => {
      if (!(await retryIfActive(error))) return false;
      await gateOnCleanup();
      return turnsActive();
    });
    if (!segments) return await dispatch(request);
    // Segments are sent in order, each with its own stale-service recovery. The recovery
    // error is raised while opening the native pipe, before the segment's action is written,
    // so its single retry resends only that segment, never an earlier delivered one. The
    // state stays per request: each recovery clears `resent` and any later send sets it,
    // so after a turn end the recovery error is returned only if nothing was sent since.
    // When this request's own turn ends (Stop or Interrupt), no further segment is sent;
    // other turns, such as a subagent's, do not stop it, except that a stale-service retry
    // is refused after any turn end, as for every request. Without turn metadata any turn
    // end stops it. A segment sent after another turn ended first waits for that turn's
    // cleanup, as a new request would; every cleanup queued since this request started went through the
    // hook, which recorded it in `endedTurns`, and earlier ones were waited for above. Any
    // segment error ends the sequence without a lossy fallback.
    const ownKey = metadata && JSON.stringify([metadata.session_id, metadata.turn_id]);
    const stopped = () => ownKey ? endedTurns.has(ownKey) || endedTurns.has(undefined) : !turnsActive();
    const run = segmentQueue.then(async () => {
      let result;
      const stop = () => Error('macOS text input stopped: the turn ended before every segment was sent');
      for (const segment of segments) {
        if (stopped()) throw stop();
        if (endedTurns.size) {
          await withStaleServiceRecovery(runtime, gateOnCleanup, retryIfActive);
          if (stopped()) throw stop();
        }
        result = await dispatch(segment);
      }
      return result;
    });
    segmentQueue = run.catch(() => {});
    return await run;
  } catch (error) {
    // A turn end after a recovery, with nothing sent since, returns the error that led to the
    // recovery whatever failed later; a retry that was sent fails with its own error.
    throw state.recoveryError && !turnsActive() && !state.resent ? state.recoveryError : error;
  } finally {
    turnEndListeners.delete(listener);
  }
}
