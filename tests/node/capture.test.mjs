import assert from 'node:assert/strict';
import { test } from 'node:test';

import { batchCommand, run } from '../../lcu/capture.mjs';

test('output larger than a pipe buffer survives a child that exits right after printing', () => {
  const script = "process.stdout.write('x'.repeat(200000)); process.stderr.write('done'); process.exit(3)";
  const result = run(process.execPath, ['-e', script]);
  assert.deepEqual([result.status, result.stdout.length, result.stderr], [3, 200000, 'done']);
});

/** What cmd.exe does to a ^-escaped line with no unescaped quotes: each ^ makes the next character literal. */
const cmdUnescape = (text) => text.replace(/\^(.)/g, '$1');

/** The C runtime's split of a command line into arguments (no program name). */
function crtSplit(line) {
  const args = [];
  let current = null;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\') {
      let count = 0;
      while (line[i] === '\\') { count += 1; i += 1; }
      if (line[i] === '"') {
        current = (current ?? '') + '\\'.repeat(count >> 1);
        if (count % 2) current += '"';
        else quoted = !quoted;
      } else {
        current = (current ?? '') + '\\'.repeat(count);
        i -= 1;
      }
    } else if (char === '"') {
      if (quoted && line[i + 1] === '"') { current = (current ?? '') + '"'; i += 1; } else quoted = !quoted;
      current ??= '';
    } else if ((char === ' ' || char === '\t') && !quoted) {
      if (current !== null) args.push(current);
      current = null;
    } else current = (current ?? '') + char;
  }
  if (current !== null) args.push(current);
  return args;
}

test('on Windows an npm .cmd or .bat shim runs through cmd.exe with every argument escaped', () => {
  const options = { cwd: 'C:\\work', timeout: 5 };
  const shim = 'C:\\npm\\omp.CMD';
  assert.deepEqual(batchCommand(shim, ['a b', 'C:\\dir\\', '50%'], options, 'win32'), ['cmd.exe',
    ['/d', '/s', '/c', '"C:\\npm\\omp.CMD ^^^"a^^^ b^^^" ^^^"C:\\dir\\\\^^^" ^^^"50^^^%^^^""'],
    { ...options, windowsVerbatimArguments: true }]);
  assert.equal(batchCommand('C:\\npm (x)\\pi.bat', [], {}, 'win32')[1][3], '"C:\\npm^ ^(x^)\\pi.bat"');
  const args = ['config', 'set', 'tools.approval', JSON.stringify({ 'mcp__lcu__js': 'allow', 'a"b': 'c\\' }, null, 2).replaceAll('\n', ' '),
    'say "hi"', '100%', '!PATH!', '%PATH%', 'x^y', 'a&b|c', '<in> out', 'C:\\dir\\', 'tail\\\\', 'back\\"slash', '', '(x)'];
  const line = batchCommand(shim, args, {}, 'win32')[1][3].slice(1, -1);
  const seen = cmdUnescape(line);
  assert.ok(seen.startsWith(`${shim} `));
  assert.deepEqual(crtSplit(cmdUnescape(seen.slice(shim.length + 1))), args, 'cmd twice (the line, then %*) and the C runtime');
  for (const bad of ['two\nlines', 'cr\r', 'nul\0']) {
    assert.throws(() => batchCommand(shim, ['config', bad], {}, 'win32'), /safely to the batch file/);
  }
  assert.deepEqual(batchCommand('C:\\app\\codex.exe', ['x'], options, 'win32'), ['C:\\app\\codex.exe', ['x'], options]);
  assert.deepEqual(batchCommand('/usr/bin/codex.cmd', ['%'], options, 'linux'), ['/usr/bin/codex.cmd', ['%'], options]);
});
