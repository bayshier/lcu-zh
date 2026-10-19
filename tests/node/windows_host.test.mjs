import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { analyze, materializeOriginalHost, planOriginalHost, startOriginalHost, stopOriginalHost } from '../../lcu/windows_host.mjs';
import { REPO, temporary, write, writeAsar } from './fixtures.mjs';

const NODE = process.execPath;
const OPTIONS = '{codexCliPath,nativePipeDirectory,windowsHelperPath,windowsHelperTransportModulePath}';
const LOCATION = '.vite/build/';
const GENERATED = `${LOCATION}lcu-original-pipe-host.cjs`;
const MAIN = `${LOCATION}main-current-hash.js`;
const minimalEnv = () => ({ PATH: process.env.PATH ?? '', ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) });

// Hand-written stand-ins for the structures of the app's bundle; none is OpenAI code.
const OLD_MAIN = "const n = require('./src-current-hash.js'); const r = require('./logger-current-hash.js'); " +
  `function Zed(${OPTIONS}) { return {pipePath: nativePipeDirectory, closeActiveTurn() { return false; }, probe: n.value + ":" + r.ok}; }`;
const SPLIT_MAIN = ['"use strict";',
  'const e=require("./rolldown-runtime-h.js"),t=require("./src-h.js"),zz=require("./unreached-h.js");',
  'let g=require("electron");g=e.a(g);', 'let v=require("node:path"),y=e.a(v,1);v=e.a(v);', 'let k=require("node:os");k=e.a(k);',
  'const LIMIT=3;', 'var cache=new Map();', 'class Counter{constructor(){this.n=0}bump(){return this.n+=LIMIT}}',
  'function helper(a,b){return a+b+LIMIT}', 'function unrelated(){return g.app+zz.value}', 'var schema=t.build({lead:1});',
  'async function Kne({codexCliPath:g,nativePipeDirectory:e,onAnalyticsEvent:t,windowsHelperPath:i,windowsHelperTransportModulePath:a}){',
  '  const count=new Counter();count.bump();cache.set("k",helper(e.length,1));', '  const load=async p=>(await import(p)).value;',
  '  return {pipePath:e,closeActiveTurn:async()=>false,hasActiveTurn:()=>false,dispose:async()=>{},',
  '    probe:[v.basename("x/y.txt"),typeof k.platform,count.n,cache.get("k"),schema,g,typeof t,typeof load].join("|")};', '}',
  'console.log("bundle bootstrap must not run");', ''].join('\n');
const SPLIT_MEMBERS = {
  'src-h.js': 'const core=require("./core-h.js");\nmodule.exports={build:o=>"built:"+o.lead+core.suffix};',
  'core-h.js': 'const dep=require("../../node_modules/dep/index.js");module.exports={suffix:dep.suffix};',
  'rolldown-runtime-h.js': 'module.exports={a:m=>m};',
  'unreached-h.js': 'require("electron");module.exports={value:1};',
  'logger-h.js': 'module.exports={ok:"logger"};',
};
const factory = (body, prelude = '') => `${prelude}\nfunction Kne(${OPTIONS}){${body};return {closeActiveTurn(){},nativePipeDirectory}}\n`;

function fixture(t) {
  const base = temporary(t);
  const app = join(base, 'original');
  const archive = join(app, 'app/resources/app.asar');
  const members = (main, extra = {}) => ({ [MAIN]: main,
    ...Object.fromEntries(Object.entries(extra).map(([name, content]) => [name.includes('/') ? name : LOCATION + name, content])) });
  const split = (main = SPLIT_MAIN) => ({ ...members(main, SPLIT_MEMBERS), 'node_modules/dep/index.js': 'module.exports={suffix:""};' });
  const plan = (files) => { writeAsar(archive, files); return planOriginalHost(app, { node: NODE }); };
  const extract = (files) => { writeAsar(archive, files); return materializeOriginalHost(app, join(base, 'extracted'), { node: NODE }); };
  const layoutError = (files, pattern) => {
    writeAsar(archive, files);
    assert.throws(() => materializeOriginalHost(app, join(base, 'derived'), { node: NODE }),
      (error) => /^Required Windows host layout is unavailable: /.test(error.message) && pattern.test(error.message));
    assert.equal(existsSync(join(base, 'derived')), false);
  };
  const runFactory = (entry) => {
    const probe = write(join(base, 'probe.cjs'), `const Module=require('node:module');const resolve=Module._resolveFilename;
Module._resolveFilename=function(request,...rest){if(request==='electron'||request.startsWith('electron/'))throw new Error('blocked electron');
  return resolve.call(this,request,...rest);};
const factory=require(process.argv[2]);
(async()=>{const host=await factory({codexCliPath:'cli',nativePipeDirectory:'/pipe-dir',windowsHelperPath:'helper',windowsHelperTransportModulePath:process.argv[3]});
  const result={keys:Object.keys(host).sort(),probe:host.probe,closed:await host.closeActiveTurn({sessionId:'s',turnId:'t'})};
  if(typeof host.dispose==='function')await host.dispose();console.log(JSON.stringify(result));})().catch(e=>{console.error(e);process.exit(1)});\n`);
    const transport = write(join(base, 'transport.mjs'), 'export const value = "transport";\n');
    const result = spawnSync(NODE, [probe, join(entry, '..', GENERATED), transport], { encoding: 'utf8', env: minimalEnv() });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { base, app, archive, members, split, plan, extract, layoutError, runFactory };
}

const requires = (source) => new Set(analyze(NODE, { op: 'host', source }).requires.map((item) => item.spec));
const files = (directory) => readdirSync(directory, { recursive: true }).filter((name) => statSync(join(directory, name)).isFile())
  .map((name) => name.split('\\').join('/'));

test('an old self-contained layout extracts the unchanged host', (t) => {
  const f = fixture(t);
  const members = f.members(OLD_MAIN, {
    'src-current-hash.js': "const dependency=require('./src-next-hash.js'); module.exports={value:dependency.value};",
    'src-next-hash.js': "const tslib=require('../../node_modules/tslib/tslib.js'); module.exports={value:'original:'+tslib.marker};",
    'logger-current-hash.js': "module.exports={ok:'logger'};", 'rolldown-runtime-unused.js': 'module.exports={};',
    'node_modules/tslib/tslib.js': "module.exports={marker:'tslib'};",
  });
  const entry = f.extract(members);
  const derived = join(entry, '..');
  const generated = readFileSync(join(derived, GENERATED), 'utf8');
  assert.ok(generated.includes(OLD_MAIN.slice(OLD_MAIN.indexOf('function Zed'))));
  assert.ok(generated.includes('module.exports = Zed;'));
  for (const [name, content] of Object.entries(members)) {
    if (name === MAIN || name.endsWith('rolldown-runtime-unused.js')) assert.equal(existsSync(join(derived, name)), false, name);
    else assert.equal(readFileSync(join(derived, name), 'utf8'), content);
  }
  const launcher = readFileSync(entry, 'utf8');
  assert.ok(!launcher.includes('ORIGINAL_WINDOWS_PIPE_HOST') && launcher.includes('require("./.vite/build/lcu-original-pipe-host.cjs")'));
  assert.equal(f.runFactory(entry).probe, 'original:tslib:logger');
  assert.ok(existsSync(join(derived, 'windows-lifetime-host.cjs')) && existsSync(join(derived, 'windows-sky-service.mjs')));
});

test('a split layout extracts a scope-correct closure and only reachable chunks', (t) => {
  const f = fixture(t);
  const entry = f.extract(f.split());
  const derived = join(entry, '..');
  const generated = readFileSync(join(derived, GENERATED), 'utf8');
  const wanted = ['const e=require("./rolldown-runtime-h.js")', 'let v=require("node:path")', 'v=e.a(v);', 'let k=require("node:os")',
    'const LIMIT=3;', 'var cache=new Map();', 'class Counter{', 'function helper(a,b){return a+b+LIMIT}', 'var schema=t.build({lead:1});',
    'async function Kne('];
  const positions = wanted.map((piece) => generated.indexOf(piece));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  for (const absent of ['electron', 'unrelated', 'zz', 'bundle bootstrap']) assert.ok(!generated.includes(absent), absent);
  assert.ok(generated.startsWith('// Generated by LCU') && generated.includes('"use strict";') && generated.trimEnd().endsWith('module.exports = Kne;'));
  assert.deepEqual(files(derived).filter((name) => /\.c?js$/.test(name) && !name.includes('windows-')).sort(),
    [GENERATED, `${LOCATION}core-h.js`, `${LOCATION}rolldown-runtime-h.js`, `${LOCATION}src-h.js`, 'node_modules/dep/index.js'].sort());
  const result = f.runFactory(entry);
  assert.equal(result.probe, 'y.txt|function|3|13|built:1|cli|undefined|function');
  assert.deepEqual(result.keys, ['closeActiveTurn', 'dispose', 'hasActiveTurn', 'pipePath', 'probe']);
  assert.equal(result.closed, false);
});

test('alias letters follow the bundle; a wrongly bound alias fails closed', (t) => {
  const f = fixture(t);
  const main = 'const c=require("node:path"),T=require("node:os"),p=require("node:fs"),v=require("node:url"),_=require("node:util"),R=require("node:crypto");\n' +
    `function Kne(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory,probe:[c.basename("a/b.txt"),typeof T.platform,typeof p.readFileSync,` +
    'typeof v.pathToFileURL,typeof _.inspect,typeof R.randomUUID].join("|")}}\n';
  assert.equal(f.runFactory(f.extract(f.members(main))).probe, 'b.txt|function|function|function|function|function');
  f.layoutError(f.members(factory('const u=c.app', 'const c=require("electron");')), /depends on Electron/);
});

test('initialisation statements travel with what they initialise; unrelated ones do not', (t) => {
  const f = fixture(t);
  const prelude = 'const state={};state.value=42;const tally={n:1};tally.n+=2;tally.n++;';
  const module = f.plan(f.members(factory('const u=state.value+tally.n', prelude))).module;
  for (const part of ['state.value=42;', 'tally.n+=2;', 'tally.n++;']) assert.ok(module.includes(part));
  f.layoutError(f.members(factory('const u=state.value', `${prelude}state.unused=require("electron");`)), /depends on Electron/);
  const sequence = f.plan(f.members(factory('const u=state.value', 'const state={},tally={n:0};state.value=41,state.value++,tally.n+=2;'))).module;
  assert.ok(sequence.includes('state.value=41,state.value++,tally.n+=2;') && sequence.includes('const tally={n:0};'));
  for (const [source, expected] of [['const state={};state.value=41,register(state);function register(){}', 'register(state);'],
    ['const state={};delete state.value;', 'delete state.value;'], ['const state={};[state.value]=[1];', '[state.value]=[1];']]) {
    assert.ok(f.plan(f.members(factory('const u=state', source))).module.includes(expected), source);
  }
  const registry = f.plan(f.members(factory('const u=registry', 'const registry=new Map();function handler(){return 7}' +
    'const unrelated=new Map();unrelated.set("x",1);registry.set("h",handler);if(registry.size){registry.set("g",handler)}'))).module;
  assert.ok(registry.includes('registry.set("h",handler);') && registry.includes('function handler(){return 7}') && !registry.includes('unrelated'));
  for (const [source, pattern] of [['const registry=new Map();registry.set("h",mystery);', /unresolved identifiers/],
    ['const registry=new Map();registry.set("h",eval("1"));', /unsupported eval/]]) {
    f.layoutError(f.members(factory('const u=registry', source)), pattern);
  }
  for (const source of ['var state=1;for(var state of [42]){}', 'var state=1;if(1){var state=2}']) {
    assert.ok(f.plan(f.members(factory('const u=state', source))).module.includes(source.split(';').slice(1).join(';')));
  }
});

test('calls that only touch imported modules are left out and counted', (t) => {
  const f = fixture(t);
  const prelude = 'const lib=require("./src-h.js"),fs=require("node:fs");const schema=lib.build({lead:1});lib.build({lead:2});fs.existsSync("x");';
  const plan = f.plan({ ...f.members(factory('const u=[schema,fs]', prelude), SPLIT_MEMBERS), 'node_modules/dep/index.js': 'module.exports={suffix:""};' });
  assert.equal(plan.uncarried, 2);
  assert.ok(plan.module.includes('2 top-level statement(s) that only call into imported modules were not carried'));
  assert.ok(!plan.module.includes('lead:2'));
});

test('hidden or indirect require and eval bindings fail closed', (t) => {
  const f = fixture(t);
  for (const prelude of ['var require;const state=require("electron");', 'function require(){}const state=require("./x.js");',
    'const state=function eval(){};']) {
    f.layoutError(f.members(factory('const u=state', prelude)), /unsupported a binding named require or eval/);
  }
  for (const prelude of ['const load=require;const state=load("electron");', 'const state=require.resolve("electron");', 'const state=typeof require;']) {
    f.layoutError(f.members(factory('const u=state', prelude)), /unsupported a reference to require/);
  }
  const main = factory('const u=a.x', 'const a=require("./src-h.js");');
  for (const chunk of ['var require;module.exports=require("electron");', 'eval("require(\\"electron\\")");']) {
    f.layoutError(f.members(main, { 'src-h.js': chunk }), /unsupported/);
  }
  f.layoutError(f.members(factory('const u=mode', 'let mode=1;function setMode(v){mode=v}')), /binding mode is reassigned/);
  assert.ok(f.plan(f.members(factory('const u=bump()', 'let mode=1;function bump(){mode+=1;return mode}'))).module.includes('mode+=1'));
});

test('relative requires resolve like Node, and unsupported dependencies fail closed', (t) => {
  const f = fixture(t);
  const main = factory('const u=a.x+b.x', 'const a=require("./cfg"),b=require("./dir");');
  assert.deepEqual(Object.keys(f.plan(f.members(main, { 'cfg.cjs': 'module.exports={x:1};', 'cfg.json': '{"x":2}',
    [`${LOCATION}dir/index.js`]: 'module.exports={x:3};' })).contents).sort(), [`${LOCATION}cfg.json`, `${LOCATION}dir/index.js`]);
  f.layoutError(f.members(main, { 'cfg.cjs': 'module.exports={x:1};', [`${LOCATION}dir/index.js`]: 'module.exports={x:3};' }), /original dependency is missing/);
  f.layoutError(f.members(main, { 'cfg.json': '{}', [`${LOCATION}dir/package.json`]: '{"main":"x.js"}', [`${LOCATION}dir/x.js`]: '' }), /package directory/);
  const slash = factory('const u=a.x', 'const a=require("./dir/");');
  assert.deepEqual(Object.keys(f.plan(f.members(slash, { 'dir.js': 'module.exports={x:1};', [`${LOCATION}dir/index.js`]: 'module.exports={x:3};' })).contents),
    [`${LOCATION}dir/index.js`]);
  f.layoutError(f.members(slash, { 'dir.js': 'module.exports={x:1};' }), /original dependency is missing/);
  for (const [extra, expression, pattern] of [[{ 'native-h.node': '\0' }, 'require("./native-h.node")', /native module/],
    [{}, 'require("left-pad")', /non-relative original dependency/], [{}, 'require("./missing-h.js")', /original dependency is missing/],
    [{}, 'import("objc-js")', /statically/], [{}, 'require(process.platform)', /non-literal/],
    [{}, 'require("../../../outside.js")', /leaves the application archive/], [{}, 'require("electron/main")', /depends on Electron/]]) {
    f.layoutError(f.members(factory(`const u=${expression}`), extra), pattern);
  }
  const graph = factory('const u=a.x', 'const a=require("./src-h.js");');
  for (const [chunk, pattern] of [['require("electron");module.exports={};', /depends on Electron/],
    ['require("./main-current-hash.js");', /reaches the main bundle/], ['require("./gone-h.js");', /original dependency is missing/],
    ['require("./addon.node");', /native module/], ['module.exports={', /does not parse/]]) {
    f.layoutError(f.members(graph, { 'src-h.js': chunk, 'addon.node': '\0' }), pattern);
  }
});

test('the plan is read-only and needs no repository hash; the factory must be unique and complete', (t) => {
  const f = fixture(t);
  const plan = f.plan(f.split());
  assert.deepEqual([plan.main, plan.factory], [MAIN, 'Kne']);
  assert.equal(existsSync(join(f.base, 'derived')), false);
  writeFileSync(f.archive, Buffer.concat([readFileSync(f.archive), Buffer.from('tampered')]));
  assert.equal(planOriginalHost(f.app, { node: NODE }).module, plan.module);
  for (const source of [`function Kne({codexCliPath,nativePipeDirectory,windowsHelperPath}){return {closeActiveTurn(){}}}`,
    `const Kne=(${OPTIONS})=>1;`, `if(1){function Kne(${OPTIONS}){return {closeActiveTurn(){}}}}`, `const decoy="function Wre(${OPTIONS}){}";`]) {
    f.layoutError(f.members(source), /no main bundle has a top-level native-pipe host factory/);
  }
  const one = `function A(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory}}\n`;
  const two = `async function B(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory}}\n`;
  f.layoutError(f.members(one + two), /more than one top-level native-pipe host factory/);
  f.layoutError({ ...f.members(one), [`${LOCATION}main-another.js`]: two }, /more than one top-level native-pipe host factory/);
  f.layoutError(f.members(`function Kne(${OPTIONS}){return {nativePipeDirectory}}`), /no longer exposes closeActiveTurn/);
  for (const body of ['const u=mystery()', 'const u=__dirname']) f.layoutError(f.members(factory(body)), /unresolved identifiers/);
});

test('scope analysis follows real references and ignores shadowed names, keys and properties', () => {
  const prelude = [...'XYZWQLMPKB'].map((name) => `const ${name}=require("electron");`).join('');
  const shadowed = 'const o={X:1,[`k`]:2,Y(){return 1},get Z(){return 1}};const a=o.Z+o?.W+o.M;function inner(X){return X}{let Y=1;Y++}' +
    'for(let Z=0;Z<1;Z++){}try{}catch(Q){Q}const {M}=o,[P]=[1];const arrow=(K=1,...B)=>K+B.length;class C{static P=1;m(Y){return Y}}';
  assert.ok(!requires(factory(shadowed, prelude)).has('electron'));
  const used = 'const X=require("electron"),B=require("node:fs");';
  for (const expression of ['({X})', '`${X}`', 'typeof X', 'new X()', 'X()', 'X?.a', '(()=>{var Y=X})()']) {
    assert.ok(requires(factory(`const u=${expression}; function tag(){} function f(){}`, used)).has('electron'), expression);
  }
  for (const body of ['var X=1;const u=X', '{const X=1;const u=X}', '(X=>X)(1)', 'function X(){}const u=X']) {
    assert.ok(!requires(factory(body, used)).has('electron'), body);
  }
  assert.throws(() => analyze(NODE, { op: 'host', source: factory('with({}){}') }), /with statement/);
  assert.throws(() => analyze(NODE, { op: 'host', source: 'function (' }), /does not parse/);
});

test('a runnable analyzer Node and an unredirected archive are required', (t) => {
  const f = fixture(t);
  writeAsar(f.archive, f.members(OLD_MAIN));
  assert.throws(() => planOriginalHost(f.app, { node: join(f.base, 'missing-node') }), /original Node needed/);
  const elsewhere = join(f.base, 'elsewhere.asar');
  writeAsar(elsewhere, f.members(OLD_MAIN));
  unlinkSync(f.archive);
  symlinkSync(elsewhere, f.archive);
  assert.throws(() => planOriginalHost(f.app, { node: NODE }), /missing or redirected/);
});

// ---- the host's lifetime ---------------------------------------------------------------------------------

function hostFixture(t, script) {
  const base = temporary(t);
  return { entry: write(join(base, 'host.cjs'), script), helper: write(join(base, 'helper.exe')), transport: write(join(base, 'transport.js')) };
}

test('the host’s ready handshake, and disposal of the owned child', async (t) => {
  const paths = hostFixture(t, "console.log(JSON.stringify({ready:true,pipePath:'\\\\\\\\.\\\\pipe\\\\lcu-wre-fixture'," +
    "lifetimePath:'\\\\\\\\.\\\\pipe\\\\lcu-lifetime-fixture'}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));\n");
  const host = await startOriginalHost({ node: NODE, ...paths, env: minimalEnv() });
  assert.deepEqual([host.pipe, host.lifetime], ['\\\\.\\pipe\\lcu-wre-fixture', '\\\\.\\pipe\\lcu-lifetime-fixture']);
  await stopOriginalHost(host.child);
  assert.equal(host.child.exitCode, 0);
});

test('a host that exits early, or reports other pipes, is an error', async (t) => {
  for (const script of ["console.log('not ready')\n", "console.log(JSON.stringify({ready:true,pipePath:'/tmp/x',lifetimePath:'/tmp/y'}))\n"]) {
    await assert.rejects(startOriginalHost({ node: NODE, ...hostFixture(t, script), env: minimalEnv() }), /failed to become ready/);
  }
  await assert.rejects(startOriginalHost({ node: NODE, ...hostFixture(t, ''), helper: '/missing', env: {} }), /incomplete/);
});

test('the private lifetime transport forwards IDs and survives a disconnect', async (t) => {
  // Windows serves the lifetime signal on a named pipe (the host's default); POSIX test hosts use a socket file.
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\lcu-lifetime-test-${randomUUID()}` : join(temporary(t), 'lifetime.sock');
  const script = "const {startLifetimeSignal}=require(process.argv[1]); let active='new'; " +
    "startLifetimeSignal(async ({sessionId,turnId})=>{ if(turnId==='disconnect'){await new Promise(r=>setTimeout(r,50)); return false;} " +
    "const matched=sessionId==='session'&&turnId===active; if(matched)active=null; return matched; }, process.argv[2]) " +
    ".then(signal=>{console.log('ready'); process.stdin.resume(); process.stdin.once('end',()=>signal.dispose().then(()=>process.exit(0)));});";
  const { spawn } = await import('node:child_process');
  const child = spawn(NODE, ['-e', script, join(REPO, 'lcu/windows_lifetime_host.cjs'), address], { env: minimalEnv() });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (code) => reject(new Error(`the lifetime host exited (${code}) before it was ready: ${stderr}`)));
  });
  const send = (turn, drop = false) => new Promise((resolve, reject) => {
    const socket = net.createConnection(address, () => {
      socket.write(`${JSON.stringify({ session_id: 'session', turn_id: turn })}\n`);
      if (drop) { socket.destroy(); resolve(null); }
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; if (data.includes('\n')) { socket.end(); resolve(JSON.parse(data)); } });
    socket.on('error', drop ? () => {} : reject);
  });
  assert.deepEqual(await send('old'), { closed: false });
  await send('disconnect', true);
  await delay(100);
  assert.equal(child.exitCode, null);
  assert.deepEqual(await send('new'), { closed: true });
  assert.deepEqual(await send('new'), { closed: false });
  child.stdin.end();
  assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0);
});

test('the Sky wrapper registers once and forwards the original service', (t) => {
  const original = write(join(temporary(t), 'original-sky.mjs'), 'export function handleRpc(request) { return request.type; }\n');
  const script = `import {pathToFileURL} from 'node:url';
let handlers = 0, ended = false, written, callback;
const listeners = {};
const socket = { on(name, fn) { listeners[name] = fn; return this; },
  write(bytes) { written = Buffer.from(bytes).toString('utf8'); queueMicrotask(() => listeners.data(Buffer.from('{"closed":true}\\n'))); },
  end() { ended = true; } };
globalThis.nodeRepl = { env: {LCU_WRE_SKY_SERVICE_PATH: process.argv[2], LCU_WRE_LIFETIME_PIPE: 'fixture'},
  nativePipe: {createConnection: async () => socket}, addTurnEndedHandler(handler) { handlers++; callback = handler.run; } };
const service = await import(pathToFileURL(process.argv[1]).href);
const first = await service.handleRpc({type:'setup'});
const second = await service.handleRpc({type:'execute'});
await callback({session_id:'session', turn_id:'turn'});
console.log(JSON.stringify({first, second, handlers, ended, written}));`;
  const result = spawnSync(NODE, ['--input-type=module', '-e', script, join(REPO, 'lcu/windows_sky_service.mjs'), original], { encoding: 'utf8', env: minimalEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { first: 'setup', second: 'execute', handlers: 1, ended: true,
    written: '{"session_id":"session","turn_id":"turn"}\n' });
});
