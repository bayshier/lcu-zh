// The few questions LCU's Linux input guard asks the X server (see linux_sky_service.mjs), asked over the
// display socket with the X11 core protocol and the X-Resource and XTEST extensions. Only the requests listed
// below are spoken; nothing here sends input except `releaseInput`, which only releases. Every question
// opens its own connection and closes it, like the single-shot helper process it replaces, and any X error,
// short reply, closed socket or timeout fails the whole question (libX11's default error handler ended that
// helper on any X error).
import {createConnection} from 'node:net';
import {readFileSync} from 'node:fs';
import {readFile, readdir, readlink} from 'node:fs/promises';
import {hostname} from 'node:os';

const TIMEOUT_MS = 3000;
const X_SOCKET_DIR = '/tmp/.X11-unix/X';
const FAMILY_INTERNET = 0;
const FAMILY_INTERNET6 = 6;
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;
const COOKIE = 'MIT-MAGIC-COOKIE-1';

// Core opcodes, and the extension minor opcodes used here.
const OP = {createWindow: 1, grabPointer: 26, ungrabPointer: 27, queryPointer: 38, translateCoordinates: 40,
  getInputFocus: 43, queryKeymap: 44, queryExtension: 98, getModifierMapping: 119};
const XRES_QUERY_VERSION = 0;
const XRES_QUERY_CLIENT_IDS = 4;
const XRES_CLIENT_ID_PID_MASK = 1 << 1;
const XTEST_FAKE_INPUT = 2;
const KEY_RELEASE = 3;
const BUTTON_RELEASE = 5;

// [protocol/]host:display[.screen], as libxcb reads $DISPLAY. An empty host or `unix` is the local socket.
export function parseDisplay(name) {
  const match = /^(?:([a-z]+)\/)?(.*):(\d+)(?:\.(\d+))?$/.exec(name ?? '');
  if (!match || match[2].endsWith(':')) return null; // DECnet (host::n) is not supported
  const [, protocol = '', host, number, screen = '0'] = match;
  const local = (host === '' || host === 'unix') && ['', 'unix', 'local'].includes(protocol);
  if (!local && !['', 'tcp', 'inet', 'inet6'].includes(protocol)) return null;
  return {local, host: local ? '' : host.replace(/^\[(.*)\]$/, '$1'), number: Number(number), screen: Number(screen)};
}

// True when the X server behind $DISPLAY provably runs in this PID namespace. Only a local display qualifies
// (:N, unix:N). The listening socket is found in /proc/net/unix (the abstract name @/tmp/.X11-unix/XN and the
// file /tmp/.X11-unix/XN), every process holding it is found through /proc/*/fd (only processes this one can
// read), and each must have the same /proc/<pid>/ns/pid link as this process. A TCP or remote display, an
// unreadable holder or no holder at all is false. A process listed in this /proc is in this PID namespace or
// one below it, so a server in another namespace is never found. The scan reads /proc asynchronously, so the
// Sky worker's event loop keeps running; past `deadline` (a Date.now() value) it stops and answers false.
export async function xServerInThisNamespace(env = process.env, {deadline = Infinity} = {}) {
  try {
    let name = env.DISPLAY ?? '';
    if (name.startsWith('unix:')) name = name.slice(4);
    if (!name.startsWith(':')) return false; // TCP, a remote host or no display
    const number = name.slice(1).split('.')[0];
    if (!/^[0-9]+$/.test(number)) return false;
    const names = new Set([X_SOCKET_DIR + number, '@' + X_SOCKET_DIR + number]);
    const inodes = new Set();
    for (const line of (await readFile('/proc/net/unix', 'utf8')).split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 8 && names.has(fields[7]) && parseInt(fields[3], 16) & 0x10000) inodes.add(fields[6]); // __SO_ACCEPTCON
    }
    if (!inodes.size) return false;
    const mine = await readlink('/proc/self/ns/pid');
    const holders = new Map();
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      if (Date.now() > deadline) return false;
      let descriptors;
      try { descriptors = await readdir(`/proc/${entry}/fd`); } catch { continue; }
      const targets = await Promise.all(descriptors.map(descriptor => readlink(`/proc/${entry}/fd/${descriptor}`).catch(() => '')));
      for (const target of targets) {
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && inodes.has(inode)) holders.set(inode, (holders.get(inode) ?? new Set()).add(entry));
      }
    }
    if (holders.size !== inodes.size) return false; // a listener whose process cannot be identified
    for (const pids of holders.values()) {
      for (const pid of pids) if (await readlink(`/proc/${pid}/ns/pid`) !== mine) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// The .Xauthority entries (libXau's format: big-endian lengths).
export function parseXauthority(data) {
  const entries = [];
  let offset = 0;
  const field = () => {
    const length = data.readUInt16BE(offset);
    const value = data.subarray(offset + 2, offset + 2 + length);
    if (value.length !== length) throw new Error('truncated');
    offset += 2 + length;
    return value;
  };
  try {
    while (offset < data.length) {
      const family = data.readUInt16BE(offset);
      offset += 2;
      entries.push({family, address: field(), number: field().toString('latin1'), name: field().toString('latin1'), data: field()});
    }
  } catch { /* a truncated tail is ignored, as libXau stops reading */ }
  return entries;
}

// The MIT-MAGIC-COOKIE-1 that libxcb would send: the address is this host's name for a local socket or a
// loopback TCP connection, else the server's IP address; a wildcard family or an empty display number matches.
export function chooseCookie(entries, {family, address, number}) {
  const wanted = String(number);
  return entries.find(entry => entry.name === COOKIE &&
    (entry.family === FAMILY_WILD || (entry.family === family && entry.address.equals(address))) &&
    (entry.number === '' || entry.number === wanted))?.data ?? null;
}

function cookieFor(display, socket, env) {
  const file = env.XAUTHORITY || (env.HOME ? `${env.HOME}/.Xauthority` : null);
  let entries;
  try { entries = parseXauthority(readFileSync(file)); } catch { return null; }
  let family = FAMILY_LOCAL;
  let address = Buffer.from(hostname());
  if (!display.local) {
    const ip = socket.remoteAddress ?? '';
    const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
    if (v4 && ip.replace(/^::ffff:/i, '') !== '127.0.0.1') {
      family = FAMILY_INTERNET;
      address = Buffer.from(v4.slice(1).map(Number));
    } else if (!v4 && ip !== '::1') {
      family = FAMILY_INTERNET6;
      address = ipv6Bytes(ip);
    }
  }
  return chooseCookie(entries, {family, address, number: display.number});
}

function ipv6Bytes(text) {
  const [head, tail = ''] = text.split('::');
  const words = part => part ? part.split(':').map(word => parseInt(word, 16)) : [];
  const left = words(head);
  const right = words(tail);
  const all = text.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  const bytes = Buffer.alloc(16);
  all.forEach((word, index) => bytes.writeUInt16BE(word & 0xffff, index * 2));
  return bytes;
}

const pad = length => (4 - length % 4) % 4;

// The connection setup request, little-endian, protocol 11.0, with an optional MIT-MAGIC-COOKIE-1.
export function setupRequest(cookie) {
  const name = cookie ? Buffer.from(COOKIE) : Buffer.alloc(0);
  const data = cookie ?? Buffer.alloc(0);
  const head = Buffer.alloc(12);
  head.write('l', 0, 'latin1');
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(0, 4);
  head.writeUInt16LE(name.length, 6);
  head.writeUInt16LE(data.length, 8);
  return Buffer.concat([head, name, Buffer.alloc(pad(name.length)), data, Buffer.alloc(pad(data.length))]);
}

// The parts of a successful setup reply LCU needs: the resource id base and the root window of every screen.
export function parseSetup(reply) {
  const vendorLength = reply.readUInt16LE(24);
  const screenCount = reply.readUInt8(28);
  const formatCount = reply.readUInt8(29);
  let offset = 40 + vendorLength + pad(vendorLength) + 8 * formatCount;
  const roots = [];
  for (let screen = 0; screen < screenCount; screen++) {
    roots.push(reply.readUInt32LE(offset));
    const depthCount = reply.readUInt8(offset + 39);
    offset += 40;
    for (let depth = 0; depth < depthCount; depth++) offset += 8 + 24 * reply.readUInt16LE(offset + 2);
  }
  return {resourceBase: reply.readUInt32LE(12), roots};
}

// One request: opcode, data byte, length in 4-byte units, then the body padded to 4 bytes.
export function request(opcode, data, body = Buffer.alloc(0)) {
  const padded = Buffer.concat([body, Buffer.alloc(pad(body.length))]);
  const head = Buffer.alloc(4);
  head.writeUInt8(opcode, 0);
  head.writeUInt8(data, 1);
  head.writeUInt16LE(1 + padded.length / 4, 2);
  return Buffer.concat([head, padded]);
}

function words(...values) {
  const body = Buffer.alloc(4 * values.length);
  values.forEach((value, index) => body.writeUInt32LE(value >>> 0, index * 4));
  return body;
}

const int16 = value => (value << 16) >> 16; // libX11 packs coordinates into INT16

export const requests = {
  queryExtension(name) {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(name.length, 0);
    return request(OP.queryExtension, 0, Buffer.concat([head, Buffer.from(name, 'latin1')]));
  },
  // XCreateSimpleWindow(root, 0, 0, 1, 1, border 0, border pixel 0, background 0): CWBackPixel | CWBorderPixel.
  createWindow(id, parent) {
    const body = Buffer.alloc(36);
    body.writeUInt32LE(id, 0);
    body.writeUInt32LE(parent, 4);
    body.writeUInt16LE(1, 12);
    body.writeUInt16LE(1, 14);
    body.writeUInt32LE(0x2 | 0x8, 24);
    return request(OP.createWindow, 0, body);
  },
  queryPointer: window => request(OP.queryPointer, 0, words(window)),
  queryKeymap: () => request(OP.queryKeymap, 0),
  getModifierMapping: () => request(OP.getModifierMapping, 0),
  // XGrabPointer(root, owner_events False, no event mask, GrabModeAsync twice, no confinement or cursor, CurrentTime).
  grabPointer(window) {
    const body = Buffer.alloc(20);
    body.writeUInt32LE(window, 0);
    body.writeUInt8(1, 6);
    body.writeUInt8(1, 7);
    return request(OP.grabPointer, 0, body);
  },
  ungrabPointer: () => request(OP.ungrabPointer, 0, words(0)),
  translateCoordinates(source, destination, x, y) {
    const body = Buffer.alloc(12);
    body.writeUInt32LE(source, 0);
    body.writeUInt32LE(destination, 4);
    body.writeInt16LE(int16(x), 8);
    body.writeInt16LE(int16(y), 10);
    return request(OP.translateCoordinates, 0, body);
  },
  getInputFocus: () => request(OP.getInputFocus, 0),
  // X-Resource QueryVersion, asking for 1.2 as libXRes does.
  xresQueryVersion: major => request(major, XRES_QUERY_VERSION, Buffer.from([1, 2, 0, 0])),
  xresQueryClientIds: (major, client) => request(major, XRES_QUERY_CLIENT_IDS, words(1, client, XRES_CLIENT_ID_PID_MASK)),
  // XTEST FakeInput with CurrentTime, no root and no device, as XTestFakeButtonEvent/XTestFakeKeyEvent send it.
  fakeInput(major, type, detail) {
    const body = Buffer.alloc(32);
    body.writeUInt8(type, 0);
    body.writeUInt8(detail, 1);
    return request(major, XTEST_FAKE_INPUT, body);
  },
};

// The process ids an X-Resource QueryClientIds reply carries, as XResGetClientPid reads them (-1 for an id
// that is not a 4-byte PID value).
export function clientIdPids(reply) {
  const pids = [];
  let offset = 32;
  for (let index = reply.readUInt32LE(8); index > 0; index--) {
    const mask = reply.readUInt32LE(offset + 4);
    const length = reply.readUInt32LE(offset + 8);
    pids.push(mask & XRES_CLIENT_ID_PID_MASK && length >= 4 ? reply.readInt32LE(offset + 12) : -1);
    offset += 12 + length;
  }
  return pids;
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.pending = new Map();
    this.failure = null;
    this.setup = new Promise((resolve, reject) => { this.setupDone = {resolve, reject}; });
    this.setup.catch(() => {}); // a socket that fails before the setup is awaited
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.read(); });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('the X server closed the connection')));
  }

  fail(error) {
    this.failure ??= error;
    this.setupDone?.reject(this.failure);
    this.setupDone = null;
    for (const {reject} of this.pending.values()) reject(this.failure);
    this.pending.clear();
    this.socket.destroy();
  }

  read() {
    if (this.setupDone) {
      if (this.buffer.length < 8) return;
      const length = 8 + 4 * this.buffer.readUInt16LE(6);
      if (this.buffer.length < length) return;
      const reply = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      if (reply[0] !== 1) return this.fail(new Error(`the X server refused the connection: ${
        reply.subarray(8, 8 + reply[1]).toString('latin1') || 'authentication required'}`));
      const {resolve} = this.setupDone;
      this.setupDone = null;
      try { resolve(parseSetup(reply)); } catch { return this.fail(new Error('malformed X setup reply')); }
    }
    while (this.buffer.length >= 32) {
      const kind = this.buffer[0] & 0x7f;
      const length = kind === 1 || kind === 35 ? 32 + 4 * this.buffer.readUInt32LE(4) : 32;
      if (this.buffer.length < length) return;
      const packet = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      if (kind === 0) return this.fail(new Error(`X error ${packet[1]} (request ${packet[10]}.${packet.readUInt16LE(8)})`));
      if (kind !== 1) continue; // an event
      const waiting = this.pending.get(packet.readUInt16LE(2));
      this.pending.delete(packet.readUInt16LE(2));
      waiting?.resolve(packet);
    }
  }

  // Sends a request; with `reply`, resolves with its reply.
  send(bytes, reply = false) {
    if (this.failure) return Promise.reject(this.failure);
    this.sequence = (this.sequence + 1) & 0xffff;
    this.socket.write(bytes);
    if (!reply) return Promise.resolve();
    return new Promise((resolve, reject) => this.pending.set(this.sequence, {resolve, reject}));
  }

  // A round trip (XSync): every earlier request has been processed, and none failed.
  sync() {
    return this.send(requests.getInputFocus(), true);
  }

  async extension(name) {
    const reply = await this.send(requests.queryExtension(name), true);
    return reply[8] ? reply[9] : null;
  }
}

function open(display, path) {
  return display.local ? createConnection({path}) : createConnection({host: display.host || 'localhost', port: 6000 + display.number});
}

// Runs `question` on a fresh connection to $DISPLAY and closes it; fails on any error or after the timeout.
export async function withDisplay(question, {env = process.env, timeoutMs = TIMEOUT_MS} = {}) {
  const display = parseDisplay(env.DISPLAY);
  if (!display) throw new Error('no usable DISPLAY');
  const paths = display.local ? [`\0${X_SOCKET_DIR}${display.number}`, `${X_SOCKET_DIR}${display.number}`] : [null];
  let connection;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    connection?.fail(new Error('the X server did not answer in time'));
  }, timeoutMs);
  try {
    let setup;
    for (const path of paths) {
      connection = new Connection(open(display, path));
      const socket = connection.socket;
      const connected = await new Promise(resolve => {
        socket.once('connect', () => resolve(true));
        socket.once('close', () => resolve(false));
      });
      if (expired) throw connection.failure;
      if (!connected) continue; // libxcb tries the abstract socket, then the file
      socket.write(setupRequest(cookieFor(display, socket, env)));
      setup = await connection.setup;
      break;
    }
    if (!setup) throw new Error('could not connect to the X server');
    const root = setup.roots[display.screen];
    if (root === undefined) throw new Error('no such X screen');
    return await question(connection, {root, resourceBase: setup.resourceBase});
  } finally {
    clearTimeout(timer);
    connection?.socket.destroy();
  }
}

// The local process the X server attributes to the window's client: X-Resource 1.2 QueryClientIds with the
// PID mask returns the SO_PEERCRED process id of the connection, and nothing for a client on another machine.
// Asked only when the X server is proven to share this PID namespace (skipped by `proof: false`, which tests
// use for what LCU trusted before 0.8.7), and then only when the server's record of this connection's own
// client (a 1x1 window it creates and never maps) equals this process's id: an additional condition, because
// equal numbers in distinct PID namespaces prove nothing. null when unknown, also when the namespace proof and
// the X round trips together take longer than `timeoutMs` (the single-shot helper's budget).
export async function clientPid(windowId, {env = process.env, proof = true, timeoutMs = TIMEOUT_MS} = {}) {
  const deadline = Date.now() + timeoutMs;
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const answer = askClientPid(windowId, {env, proof, deadline});
    answer.catch(() => {}); // a failure after the deadline has nobody left to tell
    return await Promise.race([expired, answer]);
  } finally {
    clearTimeout(timer);
  }
}

async function askClientPid(windowId, {env, proof, deadline}) {
  if (proof && !(await xServerInThisNamespace(env, {deadline}))) return null;
  if (Date.now() >= deadline) return null;
  return withDisplay(async (x, {root, resourceBase}) => {
    const major = await x.extension('X-Resource');
    if (major === null) return null;
    const version = await x.send(requests.xresQueryVersion(major), true);
    const [serverMajor, serverMinor] = [version.readUInt16LE(8), version.readUInt16LE(10)];
    if (serverMajor < 1 || (serverMajor === 1 && serverMinor < 2)) return null;
    const owner = async xid => {
      const pids = new Set(clientIdPids(await x.send(requests.xresQueryClientIds(major, xid), true)));
      pids.delete(-1);
      return pids.size === 1 ? [...pids][0] : null;
    };
    const own = resourceBase;
    await x.send(requests.createWindow(own, root));
    if (await owner(own) !== process.pid) return null; // the server numbers processes differently (or lies)
    return await owner(windowId) || null;
  }, {env, timeoutMs: Math.max(1, deadline - Date.now())});
}

// The X input state: the pointer buttons (1-5) and key codes the X server reports pressed now and the modifier
// key codes. With a root point also `grab` and `owner`. grab is the status of a brief GrabPointer on the root
// with no event mask, undone at once (0 free; 1 another client holds an active pointer grab, such as a popup
// menu or a drag in progress; 4 frozen; anything else is not usable): the grab changes nothing on the desktop,
// but pointer events arriving during that round trip are not delivered to anyone. owner is true when the
// deepest mapped window the X server finds at root point (x, y) is `windowId` or one of its descendants (the
// chain from the root down passes through it, so a window-manager frame above it is fine), false when it is
// any other window, such as an overlay. TranslateCoordinates only reads and honors input shapes.
export async function inputState(windowId, point, {env = process.env} = {}) {
  return withDisplay(async (x, {root}) => {
    const pointer = await x.send(requests.queryPointer(root), true);
    if (!pointer[1]) throw new Error('the pointer is on another screen');
    const mask = pointer.readUInt16LE(24);
    const buttons = [1, 2, 3, 4, 5].filter(number => mask & (1 << (7 + number)));
    const keymap = (await x.send(requests.queryKeymap(), true)).subarray(8, 40);
    const keys = [];
    for (let code = 0; code < 256; code++) if (keymap[code >> 3] & (1 << (code & 7))) keys.push(code);
    const table = await x.send(requests.getModifierMapping(), true);
    const codes = table.subarray(32, 32 + 8 * table[1]);
    const modifiers = [...new Set(codes)].filter(Boolean).sort((a, b) => a - b);
    const answer = {buttons, keys, modifiers, grab: null, owner: null};
    if (!point) return answer;
    const grab = (await x.send(requests.grabPointer(root), true))[1];
    if (grab === 0) await x.send(requests.ungrabPointer());
    await x.sync();
    answer.grab = grab;
    const chain = [];
    for (let current = root; ;) {
      if (chain.length >= 64) throw new Error('the window chain is too deep');
      const reply = await x.send(requests.translateCoordinates(root, current, point.x, point.y), true);
      if (!reply[1]) throw new Error('the windows are on different screens');
      const child = reply.readUInt32LE(8);
      if (child === 0) break;
      chain.push(current = child);
    }
    answer.owner = chain.includes(windowId);
    return answer;
  }, {env});
}

// Releases pointer buttons and key codes with XTEST. LCU calls it only for what a timed-out call itself pressed.
// true once the X server has processed every release.
export async function releaseInput(buttons, keys, {env = process.env} = {}) {
  return withDisplay(async x => {
    if (buttons.length || keys.length) {
      const major = await x.extension('XTEST');
      if (major === null) return false;
      for (const number of buttons) await x.send(requests.fakeInput(major, BUTTON_RELEASE, number));
      for (const code of keys) await x.send(requests.fakeInput(major, KEY_RELEASE, code));
    }
    await x.sync();
    return true;
  }, {env});
}
