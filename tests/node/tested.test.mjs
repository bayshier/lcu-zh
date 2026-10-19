import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { assess, changedSinceInstall, loadEntries, nativeInput, RECORD, report, statusLines } from '../../lcu/tested.mjs';
import { REPO, temporary } from './fixtures.mjs';

const PAIR = { platform: 'linux', architecture: 'arm64', appVersion: '26.915.31945', runtime: '0.0.16/20260915001755-492f19756c31' };
const entry = (changes = {}) => ({ platform: 'linux', architecture: 'arm64', app_version: '26.915.31945',
  runtime: PAIR.runtime, lcu_version: '0.7.0', app_sha256: 'b'.repeat(64), evidence: 'docs/releases/0.7.0.md', ...changes });
const record = (root, ...entries) => writeFileSync(join(root, RECORD), JSON.stringify({ format: 1, entries }));

test('a tested pair reports the LCU version and the package hash', (t) => {
  const root = temporary(t);
  record(root, entry(), entry({ architecture: 'x64', app_sha256: 'c'.repeat(64) }));
  const result = assess(root, PAIR);
  assert.deepEqual([result.status, result.tested, result.tested_with_lcu, result.app_sha256, result.warning],
    ['tested', true, '0.7.0', 'b'.repeat(64), null]);
  assert.match(statusLines(result)[0], /Tested pair: yes/);
});

test('an untested app version warns and lists the tested pairs', (t) => {
  const root = temporary(t);
  record(root, entry());
  const result = assess(root, { ...PAIR, appVersion: '26.999.1' });
  assert.deepEqual([result.status, result.tested], ['untested', false]);
  assert.match(result.warning, /LCU will still use it/);
  assert.ok(result.warning.includes(`ChatGPT 26.915.31945 with CUA ${PAIR.runtime}`));
  assert.deepEqual(result.tested_pairs, [{ app_version: '26.915.31945', runtime: PAIR.runtime, lcu_version: '0.7.0' }]);
  assert.equal(statusLines(result)[0], 'Tested pair: no.');
});

test('native input lists toolkits only for the exact pair, and nothing without a usable record', (t) => {
  const root = temporary(t);
  assert.deepEqual(nativeInput(root, PAIR), []);
  writeFileSync(join(root, RECORD), '{broken');
  assert.deepEqual(nativeInput(root, PAIR), []);
  record(root, entry({ native_input: ['gtk4'] }), entry({ architecture: 'x64', app_sha256: 'c'.repeat(64) }));
  assert.deepEqual(nativeInput(root, PAIR), ['gtk4']);
  assert.deepEqual(nativeInput(root, { ...PAIR, appVersion: '26.999.1' }), []);
  assert.deepEqual(nativeInput(root, { ...PAIR, architecture: 'x64' }), []);
});

test('an unknown native input toolkit invalidates the record', (t) => {
  const root = temporary(t);
  for (const value of [['gtk3'], 'gtk4', [1]]) {
    record(root, entry({ native_input: value }));
    const { entries, problem } = loadEntries(root);
    assert.equal(entries, null);
    assert.match(problem, /invalid entry/);
  }
});

test('the runtime, architecture and platform must all match', (t) => {
  const root = temporary(t);
  record(root, entry());
  assert.equal(assess(root, { ...PAIR, runtime: '0.0.99/other' }).status, 'untested');
  const arch = assess(root, { ...PAIR, architecture: 'x64' });
  assert.equal(arch.status, 'untested');
  assert.match(arch.warning, /No pair is recorded for this platform and architecture/);
  assert.equal(assess(root, { ...PAIR, platform: 'darwin' }).status, 'untested');
});

test('a missing, unreadable or invalid record is unknown and never an error', (t) => {
  const root = temporary(t);
  const missing = assess(root, PAIR);
  assert.deepEqual([missing.status, missing.tested], ['unknown', null]);
  assert.match(missing.warning, /is missing.*LCU will still use it/);
  for (const content of ['not json', JSON.stringify({ format: 2, entries: [] }), JSON.stringify({ format: 1 }),
    JSON.stringify({ format: 1, entries: [{ platform: 'linux' }] }), JSON.stringify({ format: 1, entries: [entry({ app_sha256: 'nothex' })] })]) {
    writeFileSync(join(root, RECORD), content);
    const result = assess(root, PAIR);
    assert.equal(result.status, 'unknown', content);
    assert.ok(result.warning);
  }
});

test('the checked-in record is valid and has no duplicate pairs', () => {
  const { entries, problem } = loadEntries(REPO);
  assert.equal(problem, null);
  const keys = entries.map((e) => [e.platform, e.architecture, e.app_version, e.runtime].join('|'));
  assert.equal(new Set(keys).size, keys.length);
  for (const e of entries) assert.ok(existsSync(join(REPO, e.evidence)), e.evidence);
});

test('report never throws for an unreadable app', async (t) => {
  let out = '';
  await report(temporary(t), { write: (text) => { out += text; } });
  assert.match(out, /Tested pair: unknown/);
});

test('an app changed since install is described; the recorded one is not', () => {
  const descriptor = { package_version: '1', runtime: 'r' };
  assert.equal(changedSinceInstall(descriptor, { version: '1', runtime: 'r' }), null);
  assert.equal(changedSinceInstall({}, { version: '2', runtime: 'r' }), null);
  assert.match(changedSinceInstall(descriptor, { version: '2', runtime: 'r' }), /differs from the one recorded/);
});
