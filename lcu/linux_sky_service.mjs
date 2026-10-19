// Forward the original Sky service unchanged, except for window-targeted input that the
// original Linux engine delivers with XSendEvent to toolkits that ignore it (GTK 4: press_key,
// clicks, scroll, drag and pointer moves; Qt: scroll). For those windows only, the same action is
// issued through the engine's own desktop-level call (XTEST) after the engine's own activate_window,
// with window-relative coordinates converted to desktop coordinates. No input is implemented here,
// and no key state is kept: key_down and key_up always go to the original service unchanged.
// A window is translated only when the X server itself says which local process owns it (the
// X-Resource extension, SO_PEERCRED on the server side) and that process is the one _NET_WM_PID
// names, in this PID namespace; anything else is left to the original service. That identity is
// trusted only after LCU proved that the X server runs in this PID namespace: the listening
// process of the display's local socket is found through /proc and must share this process's PID
// namespace link (a TCP display, an unidentifiable server or another namespace fails closed), and the
// server's record of LCU's own X client must equal getpid(). Every call that can change focus or
// input state (translated or not: activate_window, desktop-level and window-targeted input of any kind,
// pass-through fallbacks) runs through one queue, so nothing interleaves between a translated request's
// final focus check and its input. Read-only calls bypass the queue. Each original call made from the
// queue is bounded (a translated drag, click hold or key hold adds time for its input, up to a cap); on a
// timeout the buttons and keys that translated call itself pressed are released with XTEST, then the
// trusted worker (and with it the original engine process) is stopped so a late call cannot deliver
// input, and the call fails. If the target cannot be focused, the point is outside the target, the X
// server reports another window (a notification, a tooltip, an override-redirect popup) under a
// desktop-level pointer action's first point, another client holds an active pointer grab, or the target
// owns a modal dialog and the input is a pointer action, a translated call fails with an explicit error
// and sends nothing.
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {readFile, readlink, readdir} from 'node:fs/promises';
import {hostname} from 'node:os';
import {clientPid, inputState, releaseInput} from './x11.mjs';

const TOOLKIT_TTL_MS = 10_000;
const ACTIVATE_DEADLINE_MS = 1500;
const ACTIVATE_POLL_MS = 40;
const XPROP_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 30_000;
const DEFAULT_TOOLKITS = 'gtk4,qt-scroll';
// Windows of these runtimes handle XSendEvent themselves even if they map a GTK 4 library
// (Chromium and Electron mmap icudtl.dat; Firefox is libxul).
const NOT_GTK4 = [/\/icudtl\.dat/, /\/libxul\.so/, /\/libffmpeg\.so/];

// Questions only the X server (and the kernel) can answer: see x11.mjs (the PID namespace proof of the X server,
// the X-Resource client id, the input state, the pointer grab and window-at-point check, and the XTEST release).
// Each opens its own short connection to $DISPLAY and fails as a whole, which means "unknown".
// Replaceable by tests only.
export const deps = {
  readFile: path => readFile(path, 'utf8'),
  readLink: path => readlink(path),
  hostname: () => hostname(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  xprop: args => new Promise((resolve, reject) => {
    execFile('xprop', args, {timeout: XPROP_TIMEOUT_MS, env: {...process.env, LC_ALL: 'C'}, maxBuffer: 1 << 16},
      (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  }),
  // The X server's process id for the window's client, only when the server shares this PID namespace; else null.
  xresPid: async windowId => {
    const pid = await clientPid(windowId).catch(() => null);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  },
  // The X input state and, with a root point, the pointer grab and the window at the point (see inputState in
  // x11.mjs); null when unknown.
  guard: async (windowId, point) => {
    const answer = await inputState(windowId, point).catch(() => null);
    const numbers = value => Array.isArray(value) && value.every(Number.isInteger);
    return answer && numbers(answer.buttons) && numbers(answer.keys) && numbers(answer.modifiers) ? answer : null;
  },
  // Releases buttons and key codes with XTEST; true when the X server processed every release.
  releaseHeld: async (buttons, keys) => await releaseInput(buttons, keys).catch(() => false) === true,
  // Ends the original engine processes (sky_linux_*, children of this worker) so that a call that did not answer
  // cannot act when it resumes: SIGTERM, then SIGCONT because a stopped process acts on a pending signal only once
  // continued. Waits briefly for them to be gone. Not every original transport kills its child when the worker exits.
  stopEngines: async () => {
    const parents = new Map();
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
        parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
      } catch { /* exited */ }
    }
    const below = new Set([process.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, parent] of parents) if (below.has(parent) && !below.has(pid)) { below.add(pid); grew = true; }
    }
    below.delete(process.pid);
    const engines = [];
    for (const pid of below) {
      try {
        const argv0 = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0];
        if (argv0.slice(argv0.lastIndexOf('/') + 1).startsWith('sky_linux_')) engines.push(pid);
      } catch { /* exited */ }
    }
    for (const pid of engines) { try { process.kill(pid, 'SIGTERM'); process.kill(pid, 'SIGCONT'); } catch { /* gone */ } }
    const gone = async pid => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return stat[stat.lastIndexOf(')') + 2] === 'Z';
      } catch { return true; }
    };
    for (let round = 0; round < 20; round++) {
      if ((await Promise.all(engines.map(gone))).every(Boolean)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  },
  // Stops this trusted worker, and with it the original engine process, so that no timed-out call can act late.
  // node_repl reports the exit and starts a fresh worker for the next request.
  restartWorker: () => { setImmediate(() => process.exit(70)); },
};

let original;
let queue = Promise.resolve();
let stopped = false;
const toolkitByPid = new Map();
const PASS = Symbol('pass');

// Atomic chords are translated; key_down and key_up never are (the original engine owns held keys).
const KEY_METHODS = new Set(['press_key']);
// Calls that neither move focus nor change input state; everything else (including unknown methods) is queued.
const READ_ONLY_METHODS = new Set(['list_windows', 'list_apps', 'get_screenshot', 'get_window_state']);
const POINTER_METHODS = new Set(['click', 'scroll', 'drag', 'move']);

class Rejection extends Error {}

export function resetForTests() {
  original = undefined;
  queue = Promise.resolve();
  stopped = false;
  toolkitByPid.clear();
}

function enabledToolkits(env) {
  const raw = env.LCU_LINUX_INPUT_TOOLKITS ?? DEFAULT_TOOLKITS;
  return new Set(raw.split(',').map(item => item.trim()).filter(Boolean));
}

function disabled(env) {
  return ['off', '0', 'false', 'no'].includes(String(env.LCU_LINUX_INPUT_TRANSLATION ?? '').trim().toLowerCase());
}

function xprop(args) {
  return deps.xprop(args);
}

function cardinals(output, name) {
  const match = new RegExp(`^${name}\\([A-Z_]+\\)\\s*=\\s*(.*)$`, 'm').exec(output);
  return match ? match[1].split(',').map(item => item.trim()).filter(Boolean) : null;
}

function sameHost(machine) {
  if (typeof machine !== 'string' || !machine) return false;
  const normalize = name => String(name).trim().toLowerCase().replace(/\.$/, '');
  return normalize(machine) === normalize(deps.hostname());
}

async function windowProperties(id) {
  const output = await xprop(['-id', String(id), '_NET_WM_PID', 'WM_CLIENT_MACHINE', 'WM_TRANSIENT_FOR', '_NET_WM_STATE']);
  const pid = Number(cardinals(output, '_NET_WM_PID')?.[0]);
  const parent = /^WM_TRANSIENT_FOR\(WINDOW\):\s*window id #\s*(0x[0-9a-f]+)/im.exec(output)?.[1] ?? null;
  const state = cardinals(output, '_NET_WM_STATE') ?? [];
  const machine = /^WM_CLIENT_MACHINE\([A-Z_]+\)\s*=\s*"(.*)"\s*$/m.exec(output)?.[1] ?? null;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    machine,
    transientFor: parent ? Number.parseInt(parent, 16) : null,
    hidden: state.includes('_NET_WM_STATE_HIDDEN'),
  };
}

async function screenSize() {
  try {
    const values = cardinals(await xprop(['-root', '_NET_DESKTOP_GEOMETRY']), '_NET_DESKTOP_GEOMETRY');
    const [width, height] = (values ?? []).map(Number);
    return width > 0 && height > 0 ? {width, height} : null;
  } catch {
    return null;
  }
}

// Field 22 of /proc/<pid>/stat (process start time in clock ticks); the command name may contain
// spaces and parentheses, so fields are counted after the last closing parenthesis.
async function processStart(pid) {
  try {
    const stat = await deps.readFile(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
  } catch {
    return null;
  }
}

// _NET_WM_PID is the client's own claim, in the client's PID namespace and on the client's machine (EWMH).
// It identifies a local process only when the X server's record agrees (see classify) and this process
// shares the process's PID namespace, so a window from another namespace is never classified. Any
// failure to read either namespace link means "not shared".
async function sharesPidNamespace(pid) {
  let theirs;
  try { theirs = await deps.readLink(`/proc/${pid}/ns/pid`); } catch { return false; }
  try { return theirs === await deps.readLink('/proc/self/ns/pid'); } catch { return false; }
}

async function detectToolkit(pid) {
  const start = await processStart(pid);
  if (!start) return null; // an exited process, another account or another PID namespace
  const cached = toolkitByPid.get(pid);
  if (cached && cached.start === start && Date.now() - cached.at < TOOLKIT_TTL_MS) return cached.toolkit;
  toolkitByPid.delete(pid);
  if (!await sharesPidNamespace(pid)) return null;
  let toolkit = null;
  try {
    const maps = await deps.readFile(`/proc/${pid}/maps`);
    if (/\/libgtk-4\.so/.test(maps) && !NOT_GTK4.some(pattern => pattern.test(maps))) toolkit = 'gtk4';
    else if (/\/libQt[56]Core\.so/.test(maps)) toolkit = 'qt';
  } catch {
    return null;
  }
  if (await processStart(pid) !== start) return null; // the id was reused while it was being read
  toolkitByPid.set(pid, {toolkit, start, at: Date.now()});
  return toolkit;
}

// The toolkit is trusted only if the X server's own record of the window's client (a local process id
// from SO_PEERCRED, absent for remote clients, and only asked of a server proven to share this PID
// namespace) equals _NET_WM_PID. Otherwise the window may belong to a process in another PID namespace
// (Flatpak, containers) whose advertised id collides with an unrelated local process, or to a remote
// client, and the request is left to the original service. `wanted` is checked before the X server is
// asked, so an untranslated request (a Qt key, a Chromium window, a hidden window) never pays for it.
async function classify(id, wanted) {
  const properties = await windowProperties(id);
  if (!properties.pid || !sameHost(properties.machine)) return {...properties, toolkit: null};
  const toolkit = await detectToolkit(properties.pid);
  if (!toolkit || !wanted(toolkit, properties)) return {...properties, toolkit: null};
  let authoritative = null;
  try { authoritative = await deps.xresPid(id); } catch { /* unknown */ }
  return {...properties, toolkit: authoritative === properties.pid ? toolkit : null};
}

// Every call the queue makes to the original service is bounded. A call that does not answer in time is
// not merely abandoned (it could still deliver its input later, in the middle of a later request): the
// worker is stopped, which ends the original engine process, and the queue refuses everything after it.
// Before that, whatever a translated call itself pressed (buttons, modifiers) is released: the call may
// have pressed them and never reach its release. `options.limitMs` is the budget of a call whose duration
// follows from its input (see translatedBudgetMs); `options.held` describes what the call could press.
function callTimeoutMs(env) {
  const value = Number(env.LCU_LINUX_INPUT_CALL_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 ? value : CALL_TIMEOUT_MS;
}

// The time a translated call may take: the base bound (30 s) plus what its input implies, never more than
// the hard cap (5 minutes, or the base if that is larger). A drag adds 20 ms per path point and 2 ms per
// pixel of path length; a click adds its hold duration for every click; a key chord adds its hold duration.
// Anything else keeps the base bound.
const DRAG_POINT_MS = 20;
const DRAG_PIXEL_MS = 2;
const BUDGET_CAP_MS = 300_000;
export function translatedBudgetMs(method, input, base) {
  let extra = 0;
  if (method === 'drag' && Array.isArray(input.path)) {
    let length = 0;
    for (let index = 1; index < input.path.length; index++) {
      length += Math.hypot(input.path[index].x - input.path[index - 1].x, input.path[index].y - input.path[index - 1].y);
    }
    extra = DRAG_POINT_MS * input.path.length + DRAG_PIXEL_MS * Math.ceil(length);
  } else if (method === 'click' && finite(input.duration) && input.duration > 0) {
    extra = input.duration * Math.max(1, finite(input.click_count) ? Math.floor(input.click_count) : 1);
  } else if (method === 'press_key' && finite(input.duration) && input.duration > 0) {
    extra = input.duration;
  }
  return Math.min(base + extra, Math.max(base, BUDGET_CAP_MS));
}

const BUTTON_NUMBERS = {left: 1, l: 1, middle: 2, m: 2, right: 3, r: 3};

// What a translated call could leave pressed: the pointer buttons its action uses (a click's button, the
// left button for a drag, the wheel buttons for a scroll; none for a move), and any key it holds (the
// chord of a key press, or the `key` chord held during a pointer action).
function heldBy(method, input, before) {
  const keyboard = KEY_METHODS.has(method);
  let buttons = [];
  if (method === 'click') buttons = [BUTTON_NUMBERS[String(input.mouse_button ?? 'left').toLowerCase()] ?? 1];
  else if (method === 'drag') buttons = [1];
  else if (method === 'scroll') buttons = [4, 5];
  return {before, buttons, keys: keyboard || typeof input.key === 'string'};
}

// Releases, with XTEST, the buttons and keys the call pressed: pressed now, not pressed when the action
// started, and of a kind the call could press (modifiers only count when no key was part of the action).
async function releaseHeld(held) {
  const now = await deps.guard(0, null);
  if (!now) return;
  const buttons = now.buttons.filter(button => held.buttons.includes(button) && !held.before.buttons.includes(button));
  const keys = held.keys ? now.keys.filter(key => !held.before.keys.includes(key)) : [];
  if (buttons.length || keys.length) await deps.releaseHeld(buttons, keys);
}

function callOriginal(service, request, env, options = {}) {
  if (stopped) throw new Rejection(RESTARTING);
  const limit = options.limitMs ?? callTimeoutMs(env);
  let timer;
  let timedOut = false;
  // After the timeout fired, the outcome of the abandoned call (an engine ended by LCU fails it) is not reported:
  // the caller hears of the timeout only once the engine is ended and the release is done.
  const never = new Promise(() => {});
  const call = Promise.resolve().then(() => service.handleRpc(request)).then(value => timedOut ? never : value, async error => {
    if (timedOut) return never;
    // A call that failed by itself may also have left something pressed.
    if (options.held) { try { await releaseHeld(options.held); } catch { /* best effort */ } }
    throw error;
  });
  const expired = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      stopped = true;
      timedOut = true;
      // First end the engine (it may be stopped rather than hung, and resume), then release what it pressed.
      try { await deps.stopEngines(); } catch { /* best effort */ }
      if (options.held) { try { await releaseHeld(options.held); } catch { /* the worker stops either way */ } }
      try { deps.restartWorker(); } catch { /* the call is refused either way */ }
      reject(new Rejection(`The original Linux input service did not answer "${request.method ?? request.type}" within ` +
        `${Math.round(limit / 1000)} s. LCU stopped it so that the call cannot act later` +
        `${options.held ? ' and released the buttons and keys it had pressed' : ''}; it restarts on the next request. ` +
        'Check the desktop state and repeat the action.'));
    }, limit);
  });
  return Promise.race([call, expired]).finally(() => clearTimeout(timer));
}

const RESTARTING = 'The original Linux input service is restarting after a call that did not answer, so this call was ' +
  'not sent. Repeat the action.';

function listWindows(service, env) {
  return callOriginal(service, {type: 'execute', method: 'list_windows', args: []}, env);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function applies(toolkit, method, toolkits) {
  if (toolkit === 'gtk4') return toolkits.has('gtk4');
  if (toolkit === 'qt') return method === 'scroll' && toolkits.has('qt-scroll');
  return false;
}

function pointsOf(method, input, window) {
  if (method === 'drag') {
    return Array.isArray(input.path) && input.path.length >= 2 &&
      input.path.every(point => point && finite(point.x) && finite(point.y)) ? input.path : null;
  }
  if (method === 'click' || method === 'move') {
    return finite(input.x) && finite(input.y) && input.element_id == null ? [{x: input.x, y: input.y}] : null;
  }
  if (method === 'scroll') {
    if (input.element_id != null) return null;
    if (finite(input.x) && finite(input.y)) return [{x: input.x, y: input.y}];
    if (input.x == null && input.y == null) return [{x: Math.floor(window.width / 2), y: Math.floor(window.height / 2)}];
    return null;
  }
  return [];
}

// The first point of a pointer action (the only point of a click, scroll or move, the start of a
// drag) must lie in the target's client rectangle as it is now; a stale point would otherwise land
// on whatever application is at that place on the desktop. Drag end points may leave the target.
function requireInside(method, points, window) {
  if (!POINTER_METHODS.has(method)) return;
  const point = points[0];
  if (point.x >= 0 && point.y >= 0 && point.x < window.width && point.y < window.height) return;
  throw new Rejection(`The point (${point.x}, ${point.y}) is outside the target window's current bounds ` +
    `(${window.width}x${window.height} at ${window.x},${window.y}), so no input was sent. The window may have moved or ` +
    'been resized; read its current state and repeat the action with coordinates inside it.');
}

function outsideScreen(method, input, screen) {
  if (!screen || !POINTER_METHODS.has(method)) return false;
  return (method === 'drag' ? input.path : [input]).some(point =>
    point.x < 0 || point.y < 0 || point.x >= screen.width || point.y >= screen.height);
}

function desktopInput(method, input, window, points) {
  const {window: _window, ...rest} = input;
  if (method === 'drag') {
    return {...rest, path: points.map(point => ({x: window.x + point.x, y: window.y + point.y}))};
  }
  if (POINTER_METHODS.has(method)) {
    return {...rest, x: window.x + points[0].x, y: window.y + points[0].y};
  }
  return rest;
}

async function modalChild(target, windows) {
  const dialogs = windows.filter(window => window.modal && window.id !== target.id);
  const owned = new Set([target.id]);
  const found = [];
  // A dialog may be transient for another dialog of the same window; follow the chain.
  for (let round = 0; round < 4 && found.length < dialogs.length; round++) {
    for (const dialog of dialogs) {
      if (owned.has(dialog.id)) continue;
      let properties;
      try { properties = await windowProperties(dialog.id); } catch { continue; }
      if (properties.transientFor !== null && owned.has(properties.transientFor)) {
        owned.add(dialog.id);
        found.push(dialog);
      }
    }
  }
  return found.find(window => window.focused) ?? found.at(-1) ?? null;
}

async function waitForFocus(service, id, env) {
  const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
  for (;;) {
    const windows = await listWindows(service, env);
    if ((Array.isArray(windows) ? windows.find(window => window.id === id) : null)?.focused) return;
    if (Date.now() >= deadline) {
      throw new Rejection('LCU could not give keyboard focus to the target window, so its window-targeted input was not sent. ' +
        'Try activating the window and repeating the action.');
    }
    await deps.sleep(ACTIVATE_POLL_MS);
  }
}

// Runs inside the serialized queue: the window list, the modal state and the focus are read for this
// request only after every earlier queued call (translated or not) has finished.
async function translate(service, request, env) {
  const {method} = request;
  const input = request.args[0];
  const target = input.window;
  const keyboard = KEY_METHODS.has(method);

  let plan;
  try {
    const toolkits = enabledToolkits(env);
    const classified = await classify(target.id, (toolkit, properties) => applies(toolkit, method, toolkits) && !properties.hidden);
    if (!classified.toolkit) return PASS;
    const windows = await listWindows(service, env);
    const current = Array.isArray(windows) ? windows.find(window => window.id === target.id) : null;
    if (!current) return PASS; // the original service reports its normal error
    const points = pointsOf(method, input, current);
    if (points === null) return PASS;
    const dialog = classified.toolkit === 'gtk4' ? await modalChild(current, windows) : null;
    if (dialog && !keyboard) {
      // The dialog's toolkit grab discards pointer input for its parent, and the parent's coordinates do
      // not describe the dialog; refuse rather than guess a position.
      throw new Rejection(`The window "${current.title}" has a modal dialog "${dialog.title}" (id ${dialog.id}) that grabs ` +
        'pointer input, so no input was sent. Target the dialog window explicitly with coordinates relative to it.');
    }
    requireInside(method, points, current);
    plan = {points, focus: dialog ?? current, screen: await screenSize()};
  } catch (error) {
    if (error instanceof Rejection) throw error;
    return PASS; // classification is best effort; never block the original behavior
  }

  const {points, focus, screen} = plan;
  if (!focus.focused) {
    await callOriginal(service, {type: 'execute', method: 'activate_window', args: [{window: focus}]}, env);
    await waitForFocus(service, focus.id, env);
  }
  // Read the geometry and the focus again immediately before sending: windows move, CSD shadows differ,
  // and anything else may have taken the focus since.
  const windows = await listWindows(service, env);
  const current = Array.isArray(windows) ? windows.find(window => window.id === target.id) : null;
  if (!current) throw new Rejection('The target window disappeared before its input could be sent.');
  if (!(Array.isArray(windows) ? windows.find(window => window.id === focus.id) : null)?.focused) {
    throw new Rejection('The keyboard focus left the target window before its input could be sent, so nothing was sent. ' +
      'Repeat the action.');
  }
  requireInside(method, points, current);
  const converted = desktopInput(method, input, current, points);
  if (outsideScreen(method, converted, screen)) return PASS; // an off-screen target keeps the original error

  const before = await requireClear(target.id, method, POINTER_METHODS.has(method) ? (method === 'drag' ? converted.path[0] : converted) : null);
  return callOriginal(service, {type: 'execute', method, args: [converted]}, env, {
    limitMs: translatedBudgetMs(method, converted, callTimeoutMs(env)),
    held: heldBy(method, converted, before),
  });
}

// XTEST follows normal pointer routing, so the desktop-level action lands on whatever window the X server
// finds at the point, or goes to a client holding an active pointer grab. Immediately before sending, ask the
// X server (one connection, nothing is moved or sent): which buttons and keys are down now (the starting
// state of this call, see heldBy), and for a pointer action whether another client holds an active pointer
// grab (a popup menu, a drag in progress: the click would go to it whatever the window chain says) and
// whether the target or one of its descendants is the window at the point (a notification, a tooltip or an
// override-redirect popup can cover a target that is focused and in bounds). Anything but a free pointer and
// the target at the point, or no answer at all, fails the call with an error and sends nothing.
async function requireClear(id, method, point) {
  let state = null;
  try { state = await deps.guard(id, point && {x: Math.round(point.x), y: Math.round(point.y)}); } catch { /* unknown */ }
  if (!state) {
    throw new Rejection(point
      ? `LCU could not confirm with the X server that the target window is the one at the point (${point.x}, ${point.y}) ` +
        'and that no pointer grab is active, so no input was sent.'
      : 'LCU could not read the X server\'s input state, so no input was sent.');
  }
  if (!point) return state;
  if (state.grab === 1 || state.grab === 4) {
    throw new Rejection('Another application holds an active pointer grab (a popup menu, a drag in progress or a similar ' +
      'popup), so a click would go to it instead of the target and no input was sent. Close it or wait, then repeat the action.');
  }
  if (state.grab !== 0) {
    throw new Rejection('LCU could not tell whether another application holds an active pointer grab, so no input was sent.');
  }
  if (state.owner === true) return state;
  throw new Rejection(state.owner === false
    ? `Another window covers the point (${point.x}, ${point.y}) of the target window on the desktop (a notification, tooltip or ` +
      'popup), so no input was sent. Dismiss or wait for it, then repeat the action.'
    : `LCU could not confirm with the X server that the target window is the one at the point (${point.x}, ${point.y}), ` +
      'so no input was sent.');
}

function candidate(request) {
  if (request?.type !== 'execute' || typeof request.method !== 'string' ||
      !(KEY_METHODS.has(request.method) || POINTER_METHODS.has(request.method))) return false;
  const input = Array.isArray(request.args) && request.args.length === 1 ? request.args[0] : null;
  if (!input || !input.window || !Number.isInteger(input.window.id)) return false;
  return !KEY_METHODS.has(request.method) || typeof input.key === 'string';
}

function readOnly(request) {
  return request?.type === 'execute' && READ_ONLY_METHODS.has(request.method);
}

export async function handleRpc(request) {
  const env = globalThis.nodeRepl?.env ?? process.env;
  original ??= import(pathToFileURL(env.LCU_LINUX_SKY_SERVICE_PATH).href);
  const service = await original;
  if (disabled(env) || readOnly(request)) return service.handleRpc(request);
  // One input or focus-changing call at a time, translated or not: planning, activation, the final focus
  // check and the input of a translated request must not interleave with any other such call, including
  // activate_window, desktop-level input and the fallbacks below.
  const run = queue.then(async () => {
    if (stopped) throw new Rejection(RESTARTING);
    if (candidate(request)) {
      const result = await translate(service, request, env);
      if (result !== PASS) return result;
    }
    return callOriginal(service, request, env);
  });
  queue = run.catch(() => {});
  return run;
}
