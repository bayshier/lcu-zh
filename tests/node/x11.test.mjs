import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  chooseCookie, clientIdPids, clientPid, inputState, parseDisplay, parseSetup, parseXauthority, releaseInput, requests,
  setupRequest, withDisplay, xServerInThisNamespace,
} from '../../lcu/x11.mjs';
import { posixTests } from './fixtures.mjs';

const test = posixTests('X11 over Unix-domain sockets (Linux)');

const hex = buffer => buffer.toString('hex');
const u32 = (...values) => Buffer.from(new Uint32Array(values).buffer);

test('DISPLAY is read as libxcb reads it', () => {
  assert.deepEqual(parseDisplay(':0'), {local: true, host: '', number: 0, screen: 0});
  assert.deepEqual(parseDisplay('unix:12.1'), {local: true, host: '', number: 12, screen: 1});
  assert.deepEqual(parseDisplay('localhost:3'), {local: false, host: 'localhost', number: 3, screen: 0});
  assert.deepEqual(parseDisplay('tcp/10.0.0.2:1.0'), {local: false, host: '10.0.0.2', number: 1, screen: 0});
  assert.deepEqual(parseDisplay('[::1]:2'), {local: false, host: '::1', number: 2, screen: 0});
  for (const name of ['', ':', ':x', 'unix', 'host::0', undefined]) assert.equal(parseDisplay(name), null, String(name));
});

test('requests are encoded byte for byte as libX11, libXRes and libXtst send them', () => {
  assert.equal(hex(requests.queryExtension('XTEST')), '62000400' + '05000000' + hex(Buffer.from('XTEST')) + '000000');
  assert.equal(hex(requests.createWindow(0x200000, 0x1e3)),
    '0100' + '0a00' + hex(u32(0x200000, 0x1e3)) + '0000000001000100' + '00000000' + '00000000' + hex(u32(0xa, 0, 0)));
  assert.equal(hex(requests.queryPointer(0x1e3)), '26000200' + hex(u32(0x1e3)));
  assert.equal(hex(requests.queryKeymap()), '2c000100');
  assert.equal(hex(requests.getModifierMapping()), '77000100');
  assert.equal(hex(requests.grabPointer(0x1e3)), '1a000600' + hex(u32(0x1e3)) + '00000101' + hex(u32(0, 0, 0)));
  assert.equal(hex(requests.ungrabPointer()), '1b000200' + '00000000');
  assert.equal(hex(requests.translateCoordinates(0x1e3, 0x400001, 150, -2)),
    '28000400' + hex(u32(0x1e3, 0x400001)) + '9600' + 'feff');
  assert.equal(hex(requests.translateCoordinates(1, 2, 0x18000, 0)).slice(24, 28), '0080'); // INT16 like libX11
  assert.equal(hex(requests.getInputFocus()), '2b000100');
  assert.equal(hex(requests.xresQueryVersion(140)), '8c000200' + '01020000');
  assert.equal(hex(requests.xresQueryClientIds(140, 0x400001)), '8c040400' + hex(u32(1, 0x400001, 2)));
  assert.equal(hex(requests.fakeInput(132, 5, 1)), '84020900' + '0501' + '00'.repeat(30));
  assert.equal(hex(requests.fakeInput(132, 3, 50)), '84020900' + '0332' + '00'.repeat(30));
});

test('the setup request carries the cookie, padded', () => {
  assert.equal(hex(setupRequest(null)), '6c000b000000000000000000');
  const cookie = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  assert.equal(hex(setupRequest(cookie)), '6c000b000000' + '1200' + '1000' + '0000' +
    hex(Buffer.from('MIT-MAGIC-COOKIE-1')) + '0000' + hex(cookie));
});

function setupReply({roots = [0x1e3], base = 0x400000} = {}) {
  const screens = roots.map(root => {
    const screen = Buffer.alloc(40 + 8 + 24);
    screen.writeUInt32LE(root, 0);
    screen.writeUInt8(1, 39); // one depth
    screen.writeUInt16LE(1, 42); // with one visual
    return screen;
  });
  const fixed = Buffer.alloc(32);
  fixed.writeUInt32LE(base, 4);
  fixed.writeUInt32LE(0x1fffff, 8);
  fixed.writeUInt16LE(5, 16); // vendor length
  fixed.writeUInt8(roots.length, 20);
  fixed.writeUInt8(1, 21); // one pixmap format
  const extra = Buffer.concat([fixed, Buffer.from('Fake\0\0\0\0'), Buffer.alloc(8), ...screens]);
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0);
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(extra.length / 4, 6);
  return Buffer.concat([head, extra]);
}

test('the setup reply gives the resource id base and every screen root', () => {
  assert.deepEqual(parseSetup(setupReply({roots: [0x1e3, 0x2e3], base: 0x600000})), {resourceBase: 0x600000, roots: [0x1e3, 0x2e3]});
});

test('X-Resource client ids are read as XResGetClientPid reads them', () => {
  const reply = Buffer.alloc(32);
  reply.writeUInt32LE(3, 8);
  const pid = Buffer.concat([u32(0x400000, 2, 4), u32(4242)]);
  const other = Buffer.concat([u32(0x400000, 1, 0)]); // a client XID entry, no value
  const short = Buffer.concat([u32(0x400000, 2, 0)]);
  assert.deepEqual(clientIdPids(Buffer.concat([reply, pid, other, short])), [4242, -1, -1]);
});

function authEntry(family, address, number, name, data) {
  const field = value => { const b = Buffer.from(value); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const head = Buffer.alloc(2);
  head.writeUInt16BE(family);
  return Buffer.concat([head, field(address), field(number), field(name), field(data)]);
}

test('the cookie is chosen as libXau chooses it', () => {
  const host = Buffer.from('desk');
  const file = Buffer.concat([
    authEntry(256, 'other', '0', 'MIT-MAGIC-COOKIE-1', 'wrong host'),
    authEntry(256, 'desk', '1', 'MIT-MAGIC-COOKIE-1', 'display one'),
    authEntry(256, 'desk', '0', 'XDM-AUTHORIZATION-1', 'not supported'),
    authEntry(256, 'desk', '0', 'MIT-MAGIC-COOKIE-1', 'local zero'),
    authEntry(0, Buffer.from([10, 0, 0, 2]), '', 'MIT-MAGIC-COOKIE-1', 'any display on 10.0.0.2'),
    authEntry(65535, '', '7', 'MIT-MAGIC-COOKIE-1', 'wild seven'),
    Buffer.from([1, 0, 0]), // a truncated tail
  ]);
  const entries = parseXauthority(file);
  assert.equal(entries.length, 6);
  const pick = (family, address, number) => chooseCookie(entries, {family, address, number})?.toString() ?? null;
  assert.equal(pick(256, host, 0), 'local zero');
  assert.equal(pick(256, host, 1), 'display one');
  assert.equal(pick(0, Buffer.from([10, 0, 0, 2]), 4), 'any display on 10.0.0.2');
  assert.equal(pick(256, host, 7), 'wild seven');
  assert.equal(pick(256, host, 9), null);
});

test('only a local display can prove the X server shares this PID namespace', async () => {
  for (const DISPLAY of ['localhost:0', '127.0.0.1:0.0', 'someone:0', '', 'unix', ':', ':x', ':٣']) {
    assert.equal(await xServerInThisNamespace({DISPLAY}), false, DISPLAY);
  }
});

const LINUX_ONLY = process.platform !== 'linux' && 'the fake X server listens on an abstract Unix socket, which only Linux has';

// A scripted X server on an abstract socket (@/tmp/.X11-unix/X<n>), which libxcb and LCU try first. This process
// holds the listening socket, so the PID namespace proof holds for it.
async function fakeServer(handle, {refuse = false} = {}) {
  const seen = {cookies: [], requests: []};
  const number = 40000 + Math.floor(Math.random() * 20000);
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    let ready = false;
    let sequence = 0;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        if (buffer.length < 12) return;
        const nameLength = buffer.readUInt16LE(6);
        const dataLength = buffer.readUInt16LE(8);
        const total = 12 + nameLength + (4 - nameLength % 4) % 4 + dataLength + (4 - dataLength % 4) % 4;
        if (buffer.length < total) return;
        const nameEnd = 12 + nameLength + (4 - nameLength % 4) % 4;
        seen.cookies.push(dataLength ? buffer.subarray(nameEnd, nameEnd + dataLength).toString('hex') : null);
        buffer = buffer.subarray(total);
        if (refuse) {
          const reason = Buffer.from('No protocol specified\n\0\0');
          const head = Buffer.from([0, 22, 11, 0, 0, 0, 0, 0]);
          head.writeUInt16LE(reason.length / 4, 6);
          socket.end(Buffer.concat([head, reason]));
          return;
        }
        socket.write(setupReply());
        ready = true;
      }
      while (buffer.length >= 4 && buffer.length >= 4 * buffer.readUInt16LE(2)) {
        const length = 4 * buffer.readUInt16LE(2);
        const [opcode, data] = buffer;
        const body = buffer.subarray(4, length);
        buffer = buffer.subarray(length);
        sequence += 1;
        seen.requests.push([opcode, data]);
        const answer = handle(opcode, data, body);
        if (answer === 'hang') continue;
        if (typeof answer === 'number') { // an X error
          const error = Buffer.alloc(32);
          error.writeUInt8(answer, 1);
          error.writeUInt16LE(sequence, 2);
          error.writeUInt8(opcode, 10);
          socket.write(error);
        } else if (answer) {
          const reply = Buffer.concat([answer, Buffer.alloc(Math.max(0, 32 - answer.length))]);
          reply.writeUInt8(1, 0);
          reply.writeUInt16LE(sequence, 2);
          reply.writeUInt32LE((reply.length - 32) / 4, 4);
          socket.write(reply);
        }
      }
    });
  });
  await new Promise(resolve => server.listen(`\0/tmp/.X11-unix/X${number}`, resolve));
  return {env: {DISPLAY: `:${number}`, HOME: '/nonexistent'}, seen, close: () => server.close()};
}

const reply = (bytes = {}, size = 32) => {
  const buffer = Buffer.alloc(size);
  for (const [offset, [kind, value]] of Object.entries(bytes)) buffer[`write${kind}`](value, Number(offset));
  return buffer;
};
const EXTENSIONS = {'X-Resource': 140, XTEST: 132};

// A desktop: root 0x1e3 > frame 0x500001 > client window 0x500002 at the point; one popup elsewhere.
function desktop({pids = {}, grab = 0, version = [1, 2], keys = [38, 50], buttonMask = 1 << 8, chainAt = null} = {}) {
  return (opcode, data, body) => {
    if (opcode === 98) {
      const name = body.subarray(4, 4 + body.readUInt16LE(0)).toString();
      return name in EXTENSIONS ? reply({8: ['UInt8', 1], 9: ['UInt8', EXTENSIONS[name]]}) : reply();
    }
    if (opcode === 140 && data === 0) return reply({8: ['UInt16LE', version[0]], 10: ['UInt16LE', version[1]]});
    if (opcode === 140 && data === 4) {
      const pid = pids[body.readUInt32LE(4)];
      const head = reply({8: ['UInt32LE', pid === undefined ? 0 : 1]});
      return pid === undefined ? head : Buffer.concat([head, u32(body.readUInt32LE(4), 2, 4, pid)]);
    }
    if (opcode === 38) return reply({1: ['UInt8', 1], 24: ['UInt16LE', buttonMask]});
    if (opcode === 44) {
      const map = Buffer.alloc(32);
      for (const key of keys) map[key >> 3] |= 1 << (key & 7);
      return Buffer.concat([reply({}, 8), map]);
    }
    if (opcode === 119) return Buffer.concat([reply({1: ['UInt8', 2]}), Buffer.from([50, 62, 0, 0, 37, 105, 0, 0, 64, 108, 0, 0, 0, 0, 0, 0])]);
    if (opcode === 26) return reply({1: ['UInt8', grab]});
    if (opcode === 40) {
      const destination = body.readUInt32LE(4);
      const child = chainAt ? chainAt(destination) : {0x1e3: 0x500001, 0x500001: 0x500002}[destination] ?? 0;
      return reply({1: ['UInt8', 1], 8: ['UInt32LE', child]});
    }
    if (opcode === 43) return reply();
    return null; // CreateWindow, UngrabPointer, FakeInput: no reply
  };
}

test('clientPid trusts the window owner only after the own-client check', {skip: LINUX_ONLY}, async t => {
  const own = 0x400000;
  const server = await fakeServer(desktop({pids: {[own]: process.pid, 0x500002: 4242}}));
  t.after(server.close);
  assert.equal(await clientPid(0x500002, {env: server.env}), 4242);
  assert.equal(await clientPid(0x600000, {env: server.env}), null); // no id for the window
  assert.deepEqual(server.seen.requests.slice(0, 5), [[98, 0], [140, 0], [1, 0], [140, 4], [140, 4]]);
  assert.deepEqual(server.seen.cookies, [null, null]);
});

test('clientPid refuses a server that numbers this process differently, an old X-Resource or a TCP display', {skip: LINUX_ONLY}, async t => {
  const lying = await fakeServer(desktop({pids: {0x400000: process.pid + 1, 0x500002: 4242}}));
  t.after(lying.close);
  assert.equal(await clientPid(0x500002, {env: lying.env}), null);
  const old = await fakeServer(desktop({pids: {0x400000: process.pid, 0x500002: 4242}, version: [1, 0]}));
  t.after(old.close);
  assert.equal(await clientPid(0x500002, {env: old.env}), null);
  // Without the socket proof (what LCU trusted before 0.8.7) the same answers come back.
  const fine = await fakeServer(desktop({pids: {0x400000: process.pid, 0x500002: 4242}}));
  t.after(fine.close);
  assert.equal(await clientPid(0x500002, {env: {DISPLAY: fine.env.DISPLAY.replace(':', 'localhost:')}}), null);
  assert.equal(fine.seen.requests.length, 0); // refused before connecting
});

test('the cookie for this host and display is sent', {skip: LINUX_ONLY}, async t => {
  const server = await fakeServer(desktop());
  t.after(server.close);
  const file = join(mkdtempSync(join(tmpdir(), 'lcu-x11-')), 'Xauthority');
  const number = server.env.DISPLAY.slice(1);
  writeFileSync(file, Buffer.concat([
    authEntry(256, hostname(), String(Number(number) + 1), 'MIT-MAGIC-COOKIE-1', Buffer.alloc(16, 1)),
    authEntry(256, hostname(), number, 'MIT-MAGIC-COOKIE-1', Buffer.alloc(16, 7)),
  ]));
  await inputState(0, null, {env: {...server.env, XAUTHORITY: file}});
  assert.deepEqual(server.seen.cookies, ['07'.repeat(16)]);
});

test('inputState reports pressed buttons, keys, modifiers, the grab and the owner chain', {skip: LINUX_ONLY}, async t => {
  const server = await fakeServer(desktop());
  t.after(server.close);
  assert.deepEqual(await inputState(0, null, {env: server.env}),
    {buttons: [1], keys: [38, 50], modifiers: [37, 50, 62, 64, 105, 108], grab: null, owner: null});
  assert.deepEqual(server.seen.requests, [[38, 0], [44, 0], [119, 0]]);
  server.seen.requests.length = 0;
  const state = await inputState(0x500002, {x: 150, y: 130}, {env: server.env});
  assert.deepEqual(state, {buttons: [1], keys: [38, 50], modifiers: [37, 50, 62, 64, 105, 108], grab: 0, owner: true});
  assert.deepEqual(server.seen.requests, [[38, 0], [44, 0], [119, 0], [26, 0], [27, 0], [43, 0], [40, 0], [40, 0], [40, 0]]);
  assert.equal((await inputState(0x500001, {x: 1, y: 1}, {env: server.env})).owner, true); // the frame is in the chain
  assert.equal((await inputState(0x700000, {x: 1, y: 1}, {env: server.env})).owner, false); // another window
});

test('an active grab by another client is reported and not undone', {skip: LINUX_ONLY}, async t => {
  const server = await fakeServer(desktop({grab: 1}));
  t.after(server.close);
  const state = await inputState(0x500002, {x: 1, y: 1}, {env: server.env});
  assert.equal(state.grab, 1);
  assert.ok(!server.seen.requests.some(([opcode]) => opcode === 27));
});

test('an endless window chain, an X error, a refused connection or a silent server is unknown', {skip: LINUX_ONLY}, async t => {
  const deep = await fakeServer(desktop({chainAt: window => window + 1}));
  t.after(deep.close);
  await assert.rejects(inputState(1, {x: 0, y: 0}, {env: deep.env}), /too deep/);
  const failing = await fakeServer((opcode, data, body) => opcode === 44 ? 2 : desktop()(opcode, data, body));
  t.after(failing.close);
  await assert.rejects(inputState(1, null, {env: failing.env}), /X error 2/);
  const refusing = await fakeServer(desktop(), {refuse: true});
  t.after(refusing.close);
  await assert.rejects(inputState(1, null, {env: refusing.env}), /No protocol specified/);
  const silent = await fakeServer(() => 'hang');
  t.after(silent.close);
  await assert.rejects(withDisplay(x => x.sync(), {env: silent.env, timeoutMs: 100}), /did not answer in time/);
  await assert.rejects(inputState(1, null, {env: {DISPLAY: ':59999'}}));
});

test('releaseInput sends XTEST releases and confirms them with a round trip', {skip: LINUX_ONLY}, async t => {
  const server = await fakeServer(desktop());
  t.after(server.close);
  assert.equal(await releaseInput([1, 3], [50], {env: server.env}), true);
  assert.deepEqual(server.seen.requests, [[98, 0], [132, 2], [132, 2], [132, 2], [43, 0]]);
  server.seen.requests.length = 0;
  assert.equal(await releaseInput([], [], {env: server.env}), true);
  assert.deepEqual(server.seen.requests, [[43, 0]]);
  const bad = await fakeServer((opcode, data, body) => opcode === 132 ? 2 : desktop()(opcode, data, body));
  t.after(bad.close);
  await assert.rejects(releaseInput([], [3], {env: bad.env}), /X error 2/);
  const bare = await fakeServer((opcode, data, body) => opcode === 98 ? reply() : desktop()(opcode, data, body));
  t.after(bare.close);
  assert.equal(await releaseInput([1], [], {env: bare.env}), false);
});

test('the namespace proof and the X round trips share one deadline; past it the owner is unknown', {skip: LINUX_ONLY}, async t => {
  const server = await fakeServer(desktop({pids: {0x400000: process.pid, 0x500002: 4242}}));
  t.after(server.close);
  assert.equal(await xServerInThisNamespace(server.env), true);
  assert.equal(await xServerInThisNamespace(server.env, {deadline: 0}), false);
  const silent = await fakeServer(() => 'hang');
  t.after(silent.close);
  const started = Date.now();
  assert.equal(await clientPid(0x500002, {env: silent.env, timeoutMs: 200}).catch(() => null), null); // as the guard asks
  assert.ok(Date.now() - started < 1000);
});
