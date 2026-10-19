import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalBroker } from '../client.mjs';

const MOD = 'toolu_plugin_abc';
const params = (meta = {}) => ({
  mode: 'form',
  message: 'Allow Computer Use to use "Zed"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    connector_id: 'computer-use',
    persist: ['session', 'always'],
    riskLevel: 'low',
    tool_params: { app: 'dev.zed.Zed' },
    tool_params_display: [{ name: 'app', display_name: 'App', value: 'Zed' }],
    ...meta,
  },
});

function clock() {
  let time = 1_000;
  return { now: () => time, advance(ms) { time += ms; } };
}

test('open describes display data, risk and the runtime warning', () => {
  const broker = createApprovalBroker();
  const warning = 'Allowing ChatGPT to use this app introduces new risks.';
  const id = broker.open(params({ riskLevel: 'high', warningSubtitle: warning, persist: ['session'] }));
  const { ok, approval } = broker.describe('Allow Computer Use to use "Zed"?', MOD);
  assert.equal(ok, true);
  assert.deepEqual(approval, {
    id, message: 'Allow Computer Use to use "Zed"?', app: 'dev.zed.Zed', label: 'Zed',
    scopes: ['session'], riskLevel: 'high', warning,
  });
  assert.equal(broker.open(params({ riskLevel: 'high', subtitle: 'From the subtitle.' })) !== id, true);
  assert.equal(broker.describe('Allow Computer Use to use "Zed"?', MOD).approval.warning, 'From the subtitle.');
});

test('requests that are not native-app approvals open no record', () => {
  const broker = createApprovalBroker();
  assert.equal(broker.open({ mode: 'form', message: 'Enter a secret.', requestedSchema: { type: 'object', properties: { a: { type: 'string' } } } }), undefined);
  assert.equal(broker.size, 0);
});

test('a choice is accepted once, only from a mod call and for a described record', () => {
  const broker = createApprovalBroker();
  const id = broker.open(params());
  assert.equal(broker.choose(id, 'session', MOD).ok, false, 'not described yet');
  broker.describe('Allow Computer Use to use "Zed"?', MOD);
  assert.equal(broker.choose(id, 'session', 'toolu_01real').ok, false);
  assert.equal(broker.choose(id, 'session', undefined).ok, false);
  assert.equal(broker.choose('other', 'session', MOD).ok, false);
  assert.equal(broker.choose(id, 'maybe', MOD).ok, false);
  assert.equal(broker.choose(id, 'always', MOD).ok, true);
  assert.equal(broker.choose(id, 'deny', MOD).ok, false, 'replay');
  assert.equal(broker.settle(id), 'always');
  assert.equal(broker.settle(id), undefined, 'single use');
  assert.equal(broker.choose(id, 'session', MOD).ok, false, 'record deleted');
});

test('always is refused when the runtime did not offer it', () => {
  const broker = createApprovalBroker();
  const id = broker.open(params({ persist: ['session'] }));
  broker.describe('Allow Computer Use to use "Zed"?', MOD);
  assert.equal(broker.choose(id, 'always', MOD).ok, false);
  assert.equal(broker.choose(id, 'session', MOD).ok, true);
  assert.equal(broker.settle(id), 'session');
});

test('session without a session scope maps to a plain accept', () => {
  const broker = createApprovalBroker();
  const id = broker.open(params({ persist: [] }));
  broker.describe('Allow Computer Use to use "Zed"?', MOD);
  assert.equal(broker.choose(id, 'session', MOD).ok, true);
  assert.equal(broker.settle(id), 'once');
});

test('a choice expires if the host answer comes too late', () => {
  const time = clock();
  const broker = createApprovalBroker({ now: time.now, ttlMs: 5_000 });
  const id = broker.open(params());
  broker.describe('Allow Computer Use to use "Zed"?', MOD);
  time.advance(60_000); // a person may take long in the pane
  assert.equal(broker.choose(id, 'session', MOD).ok, true);
  time.advance(5_001);
  assert.equal(broker.settle(id), undefined);
  assert.equal(broker.size, 0);
});

test('deny settles as decline and cancel as cancel; parallel requests are claimed in order', () => {
  const broker = createApprovalBroker();
  const first = broker.open(params());
  const second = broker.open(params());
  const message = 'Allow Computer Use to use "Zed"?';
  assert.equal(broker.describe(message, 'toolu_01model').ok, false, 'the model cannot claim a record');
  assert.equal(broker.describe(message, MOD).approval.id, first);
  assert.equal(broker.describe(message, MOD).approval.id, second);
  assert.equal(broker.describe(message, MOD).ok, false);
  broker.choose(first, 'deny', MOD);
  broker.choose(second, 'cancel', MOD);
  assert.equal(broker.settle(first), 'decline');
  assert.equal(broker.settle(second), 'cancel');
});

test('awaitChoice waits for a claimed record\'s choice, and gives up when the request ends or aborts', async () => {
  const broker = createApprovalBroker();
  const message = 'Allow Computer Use to use "Zed"?';
  const unclaimed = broker.open(params());
  assert.equal(broker.isClaimed(unclaimed), false);
  assert.equal(await broker.awaitChoice(unclaimed), undefined, 'no mod claimed it');
  assert.equal(await broker.awaitChoice('other'), undefined);
  broker.settle(unclaimed);

  const first = broker.open(params());
  broker.describe(message, MOD);
  assert.equal(broker.isClaimed(first), true);
  const waiting = broker.awaitChoice(first);
  broker.choose(first, 'deny', MOD);
  assert.equal(await waiting, 'decline');
  assert.equal(broker.size, 0, 'settled with the choice');

  const recorded = broker.open(params());
  broker.describe(message, MOD);
  broker.choose(recorded, 'session', MOD);
  assert.equal(await broker.awaitChoice(recorded), 'session', 'already recorded');

  const second = broker.open(params());
  broker.describe(message, MOD);
  const ended = broker.awaitChoice(second);
  broker.settle(second);
  assert.equal(await ended, undefined);

  const third = broker.open(params());
  broker.describe(message, MOD);
  const controller = new AbortController();
  const aborted = broker.awaitChoice(third, controller.signal);
  controller.abort();
  assert.equal(await aborted, undefined);
  assert.equal(broker.size, 0);
});
