// `lcu origins`: list and forget saved Chrome site decisions, against a temporary CODEX_HOME.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, renameSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as origins from '../../lcu/origins.mjs';
import { defaultCodexHome } from '../../lcu/runtime.mjs';
import { output, override, posixOnly, temporary, write } from './fixtures.mjs';
import { parse as parseToml } from '../../lcu/toml.mjs';

const SAMPLE = '[origins]\nallowed = ["https://ok.example"]\ndenied = ["https://bad.example", "http://localhost:3000"]\n';

function fixture(t) {
  const home = join(temporary(t), 'codex');
  const sessions = join(home, 'browser/sessions');
  const f = { home, sessions, env: { CODEX_HOME: home } };
  f.session = (name, text = SAMPLE) => write(join(sessions, `${name}.toml`), text);
  f.run = async (...argv) => {
    const seen = await output(t);
    // CODEX_HOME is a native temporary directory, so it is checked with this platform's path rules.
    const code = await origins.main(argv, { env: f.env });
    return { code, out: seen.out, err: seen.err };
  };
  f.state = (name) => origins.parse(readFileSync(join(sessions, `${name}.toml`)), name).origins;
  f.files = () => readdirSync(sessions).filter((name) => name !== origins.LOCK_NAME).sort();
  return f;
}

test('list shows every session, defaults without a subcommand, and prints JSON', async (t) => {
  const f = fixture(t);
  f.session('abc');
  f.session('agent-2', '[origins]\ndenied = ["https://x.example"]\n');
  const { code, out } = await f.run('list');
  assert.equal(code, 0);
  assert.ok(out.includes('session abc') && out.includes('allowed https://ok.example') && out.includes('denied  http://localhost:3000') && out.includes('session agent-2'));
  const document = JSON.parse((await f.run('--json')).out);
  assert.equal(document.codexHome, f.home);
  assert.deepEqual(document.sessions[0], { session: 'abc', file: join(f.sessions, 'abc.toml'), allowed: ['https://ok.example'],
    denied: ['https://bad.example', 'http://localhost:3000'] });
  assert.deepEqual(document.problems, []);
  const one = await f.run('list', '--session', 'agent-2');
  assert.ok(one.out.includes('https://x.example') && !one.out.includes('ok.example'));
});

test('list with nothing saved, unreadable, unfamiliar or wrongly shaped files', async (t) => {
  const f = fixture(t);
  assert.match((await f.run('list')).out, /No saved Chrome site decisions/);
  f.session('empty', '[origins]\nallowed = []\ndenied = []\n');
  assert.match((await f.run('list')).out, /No saved/);
  f.session('good');
  f.session('broken', 'not = [valid');
  let result = await f.run('list');
  assert.equal(result.code, 1);
  assert.ok(result.out.includes('session good') && !result.out.includes('No saved') && result.err.includes('broken.toml'));
  assert.deepEqual(JSON.parse((await f.run('list', '--json')).out).problems.map((p) => p.session), ['broken']);
  result = await f.run('list', '--session', 'broken');
  assert.equal(result.code, 1);
  assert.match(result.err, /not valid TOML/);
  const g = fixture(t);
  for (const text of ['[history]\nurls = ["https://x.example"]\n', 'version = 1\n', '[origins]\nblocked = ["https://x.example"]\n']) {
    g.session('odd', text);
    result = await g.run('list');
    assert.equal(result.code, 1, text);
    assert.match(result.err, /expected \[origins\] allowed\/denied/);
    assert.equal((await g.run('forget', 'https://x.example', '--session', 'odd')).code, 1);
    assert.equal(readFileSync(join(g.sessions, 'odd.toml'), 'utf8'), text);
  }
  for (const text of ['', '[origins]\n', '[origins]\ndenied = []\n', '[origins]\nallowed = ["https://a.example"]\n']) {
    g.session('odd', text);
    assert.equal((await g.run('list', '--session', 'odd')).code, 0, text);
  }
  for (const text of ['origins = 3\n', '[origins]\ndenied = "https://x.example"\n', '[origins]\ndenied = [1]\n']) {
    g.session('odd', text);
    result = await g.run('list', '--session', 'odd');
    assert.equal(result.code, 1, text);
    assert.match(result.err, /leaving it untouched/);
  }
});

test('list ignores files that are not session files', async (t) => {
  const f = fixture(t);
  f.session('abc');
  write(join(f.sessions, 'notes.txt'), 'x');
  f.session('has space');
  f.session('.hidden');
  assert.deepEqual(JSON.parse((await f.run('list', '--json')).out).sessions.map((entry) => entry.session), ['abc']);
});

test('forget removes from denied by default, from allowed only when asked, and normalizes', async (t) => {
  const f = fixture(t);
  const path = f.session('abc');
  let result = await f.run('forget', 'http://localhost:3000');
  assert.equal(result.code, 0);
  assert.ok(result.out.includes('Removed http://localhost:3000 from denied in session abc.') && result.out.includes('5 minutes'));
  assert.equal(readFileSync(path, 'utf8'), '[origins]\nallowed = ["https://ok.example"]\ndenied = ["https://bad.example"]\n');
  result = await f.run('forget', 'https://ok.example');
  assert.ok(result.out.includes('nothing changed') && !result.out.includes('5 minutes'));
  await f.run('forget', 'https://ok.example', '--allowed');
  assert.deepEqual(f.state('abc'), { allowed: [], denied: ['https://bad.example'] });
  f.session('both', '[origins]\nallowed = ["https://a.example"]\ndenied = ["https://a.example"]\n');
  await f.run('forget', 'https://a.example', '--allowed', '--denied');
  assert.deepEqual(f.state('both'), { allowed: [], denied: [] });
  f.session('case', '[origins]\ndenied = ["HTTPS://Bad.Example:443", "https://bad.example"]\n');
  result = await f.run('forget', 'https://BAD.example/', '--session', 'case');
  assert.match(result.out, /Removed 2 entries for https:\/\/bad\.example from denied/);
  assert.deepEqual(f.state('case').denied, []);
});

test('forget covers every session by default and one with --session', async (t) => {
  const f = fixture(t);
  f.session('three', '[origins]\ndenied = ["https://other.example"]\n');
  for (const flag of [[], ['--all-sessions']]) {
    f.session('one');
    f.session('two');
    assert.equal((await f.run('forget', 'https://bad.example', ...flag)).code, 0);
    assert.deepEqual([f.state('one').denied, f.state('two').denied, f.state('three').denied],
      [['http://localhost:3000'], ['http://localhost:3000'], ['https://other.example']]);
  }
  f.session('one');
  f.session('two');
  await f.run('forget', 'https://bad.example', '--session', 'two');
  assert.deepEqual([f.state('one').denied, f.state('two').denied], [['https://bad.example', 'http://localhost:3000'], ['http://localhost:3000']]);
  assert.equal((await f.run('forget', 'https://a.example', '--session', 'a', '--all-sessions')).code, 2);
  assert.equal((await f.run('forget')).code, 2);
});

test('forget keeps other keys, special characters and the file mode', { skip: posixOnly('POSIX file modes') }, async (t) => {
  const f = fixture(t);
  const path = f.session('abc', 'version = 2\nname = "agent"\n\n[origins]\nallowed = ["https://ok.example"]\n' +
    'denied = ["https://bad.example"]\nnote = "kept"\nflag = true\n"odd key" = "caf\\u00e9 \\"quoted\\" \\\\"\n\n[other]\nitems = ["a", "b"]\n');
  chmodSync(path, 0o640);
  await f.run('forget', 'https://bad.example');
  assert.deepEqual(parseToml(readFileSync(path, 'utf8')), { version: 2, name: 'agent', origins: { allowed: ['https://ok.example'], denied: [],
    note: 'kept', flag: true, 'odd key': 'café "quoted" \\' }, other: { items: ['a', 'b'] } });
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.deepEqual(f.files(), ['abc.toml']);
});

test('forget leaves structures it cannot rewrite untouched; a # inside a string is not a comment', async (t) => {
  const f = fixture(t);
  for (const text of ['# written by hand\n[origins]\ndenied = ["https://bad.example"]\n', '[origins]\ndenied = ["https://bad.example"] # keep\n',
    '[origins]\ndenied = ["https://bad.example"]\n[origins.extra]\nx = 1\n', 'ratio = 1.5\n[origins]\ndenied = ["https://bad.example"]\n',
    'at = 2026-10-06\n[origins]\ndenied = ["https://bad.example"]\n', '[[history]]\nurl = "x"\n[origins]\ndenied = ["https://bad.example"]\n',
    'note = """a\nb"""\n[origins]\ndenied = ["https://bad.example"]\n']) {
    const path = f.session('abc', text);
    const { code, out, err } = await f.run('forget', 'https://bad.example', '--session', 'abc');
    assert.equal(code, 1, text);
    assert.match(err, /leaving it untouched/);
    assert.ok(!out.includes('5 minutes'));
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.deepEqual(f.files(), ['abc.toml']);
  }
  const path = f.session('abc', '[origins]\ndenied = ["https://bad.example", "https://a.example/#x"]\n');
  assert.equal((await f.run('forget', 'https://bad.example')).code, 0);
  assert.deepEqual(f.state('abc').denied, ['https://a.example/#x']);
  assert.ok(readFileSync(path, 'utf8').includes('#x'));
});

test('a bad file does not block the others but fails the run; symbolic links are refused', async (t) => {
  const f = fixture(t);
  f.session('good');
  const broken = f.session('broken', '# note\n[origins]\ndenied = ["https://bad.example"]\n');
  const { code, out, err } = await f.run('forget', 'https://bad.example');
  assert.equal(code, 1);
  assert.ok(err.includes('broken.toml') && out.includes('5 minutes'));
  assert.deepEqual(f.state('good').denied, ['http://localhost:3000']);
  assert.ok(readFileSync(broken, 'utf8').startsWith('# note'));
  const real = f.session('real');
  symlinkSync(real, join(f.sessions, 'linked.toml'));
  const linked = await f.run('forget', 'https://bad.example', '--session', 'linked');
  assert.equal(linked.code, 1);
  assert.match(linked.err, /symbolic link/);
  assert.equal(readFileSync(real, 'utf8'), SAMPLE);
});

/** A temporary-file writer for forgetIn that lets the test act as the original runtime writing meanwhile. */
const writer = (during) => (target, text) => {
  const temporary = `${target}.next`;
  writeFileSync(temporary, text);
  during?.(target);
  return temporary;
};
const BAD = ['https://bad.example', ['denied']];

test('forget recomputes after a runtime write, reports a write after the replace, and gives up when the file never settles', async (t) => {
  const f = fixture(t);
  const path = f.session('abc');
  let raced = false;
  await origins.forgetIn(path, ...BAD, { files: { writeTemporary: writer((target) => {
    if (!raced) writeFileSync(target, '[origins]\nallowed = ["https://new.example"]\ndenied = ["https://bad.example", "https://late.example"]\n');
    raced = true;
  }) } });
  assert.deepEqual(f.state('abc'), { allowed: ['https://new.example'], denied: ['https://late.example'] });
  assert.deepEqual(f.files(), ['abc.toml']);
  f.session('abc');
  let count = 0;
  await assert.rejects(origins.forgetIn(path, ...BAD, { files: { writeTemporary: writer((target) => {
    count += 1;
    writeFileSync(target, `[origins]\ndenied = ["https://bad.example", "https://n${count}.example"]\n`);
  }) } }), /kept changing/);
  assert.ok(readFileSync(path, 'utf8').includes('bad.example'));
  assert.deepEqual(f.files(), ['abc.toml']);
  f.session('abc');
  await assert.rejects(origins.forgetIn(path, ...BAD, { files: { replace: (source, target) => {
    renameSync(source, target);
    writeFileSync(target, '[origins]\ndenied = ["https://late.example"]\n');
  } } }), /original runtime changed/);
});

test('file system errors become messages; a vanished file is reported', async (t) => {
  const f = fixture(t);
  const path = f.session('one');
  await assert.rejects(origins.forgetIn(path, ...BAD, { files: { writeTemporary: () => {
    throw Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: 'EACCES' });
  } } }), (error) => error instanceof origins.OriginsError && /cannot update .*permission denied/.test(error.message));
  assert.deepEqual(f.state('one').denied, ['https://bad.example', 'http://localhost:3000']);
  await assert.rejects(origins.forgetIn(path, ...BAD, { files: { read: (target) => {
    const data = readFileSync(target);
    unlinkSync(target);
    return data;
  } } }), /cannot update/);
});

test('a float in a session file is not rewritten as an integer; CODEX_HOME is normalized', async (t) => {
  const f = fixture(t);
  const text = 'ratio = 1.0\n[origins]\ndenied = ["https://bad.example"]\n';
  const path = f.session('abc', text);
  assert.equal((await f.run('forget', 'https://bad.example')).code, 1);
  assert.equal(readFileSync(path, 'utf8'), text);
  assert.equal(origins.codexHome({ CODEX_HOME: '/c/x/' }, { windows: false }), '/c/x');
  assert.equal(origins.codexHome({ CODEX_HOME: '/' }, { windows: false }), '/');
});

test('concurrent forgets are serialized; a lock that stays held is reported', async (t) => {
  const f = fixture(t);
  const path = f.session('abc', '[origins]\nallowed = ["https://a.example", "https://b.example"]\n');
  await output(t);
  let release;
  const held = origins.locked(f.sessions, () => new Promise((done) => { release = done; }));
  await new Promise((done) => setTimeout(done, 20));
  await assert.rejects(origins.locked(f.sessions, async () => {}, { wait: 200 }), /another `lcu origins` command/);
  const second = origins.forgetIn(path, 'https://b.example', ['allowed']);
  let finished = false;
  second.then(() => { finished = true; });
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(finished, false, 'the second command ran while the first held the lock');
  release();
  await held;
  await second;
  await origins.forgetIn(path, 'https://a.example', ['allowed']);
  assert.deepEqual(f.state('abc').allowed, []);
  // POSIX keeps the flock file, as earlier releases left it; the Windows lock file is removed on release (lock.mjs).
  assert.equal(existsSync(join(f.sessions, origins.LOCK_NAME)), process.platform !== 'win32', 'the lock file stays on POSIX only');
});

test('session ids, missing sessions and invalid origins are refused before any change', async (t) => {
  const f = fixture(t);
  const path = f.session('abc');
  for (const name of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(129), 'a b', 'é', 'abc\n']) {
    for (const argv of [['list', '--session', name], ['forget', 'https://a.example', '--session', name]]) {
      const { code, err } = await f.run(...argv);
      assert.equal(code, 1, JSON.stringify(argv));
      assert.match(err, /not a session id/);
    }
  }
  assert.equal(origins.checkSessionId('x'.repeat(128)), 'x'.repeat(128));
  assert.match((await f.run('forget', 'https://bad.example', '--session', 'nope')).err, /no saved site decisions for session nope/);
  for (const value of ['example.com', 'localhost:3000', 'ftp://a.example', 'https://a.example/path', 'https://a.example?x=1', 'https://a.example#x',
    'https://user@a.example', 'https://', 'https://a b.example', 'https://a.example:99999', '*', '', 'https://bücher.de', 'https://faß.de',
    'http://0x7f.1', 'http://127.1', 'http://2130706433', 'http://[::g]']) {
    assert.equal((await f.run('forget', value)).code, 1, value);
    assert.equal(readFileSync(path, 'utf8'), SAMPLE);
  }
});

test('origins are normalized as a browser reports them', () => {
  const cases = { 'https://Example.com': 'https://example.com', 'https://example.com:443/': 'https://example.com',
    'http://example.com:80': 'http://example.com', 'http://localhost:3000': 'http://localhost:3000',
    'https://example.com:8443': 'https://example.com:8443', 'http://[::1]:8080': 'http://[::1]:8080',
    'https://xn--bcher-kva.de': 'https://xn--bcher-kva.de', ' https://a.example ': 'https://a.example',
    'http://[2001:DB8:0:0::1]:81': 'http://[2001:db8::1]:81', 'https://127.0.0.1': 'https://127.0.0.1' };
  for (const [value, expected] of Object.entries(cases)) assert.equal(origins.normalizeOrigin(value), expected, value);
});

test('CODEX_HOME resolves as the runtime sees it; an empty or relative one is refused', async (t) => {
  assert.equal(origins.codexHome({ CODEX_HOME: '/c' }, { windows: false }), '/c');
  assert.equal(origins.codexHome({ HOME: '/home/a' }, { windows: false }), '/home/a/.codex');
  assert.equal(origins.codexHome({ HOME: '//home/a' }, { windows: false }), '/home/a/.codex');
  assert.equal(defaultCodexHome({ USERPROFILE: 'C:\\Users\\a', HOME: '/x' }, true), 'C:\\Users\\a\\.codex');
  const f = fixture(t);
  for (const value of ['', 'relative/dir']) {
    f.env = { CODEX_HOME: value };
    const { code, err } = await f.run('list');
    assert.equal(code, 1);
    assert.match(err, /CODEX_HOME/);
  }
});
