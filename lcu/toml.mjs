// A TOML 1.0 reader for the files LCU inspects: Codex's config.toml, the original browser service's session
// files, and the inline permission profile `codex sandbox` receives. LCU never writes TOML through this module;
// Codex's own writer and add-mcp do. Values come back as plain objects, arrays, strings, numbers and booleans;
// a date or time stays its text (TomlDateTime), and with `{floats: true}` a float is a TomlFloat, for callers
// that must tell 1.0 from 1. Invalid input throws. Codex validates its own config, so only what LCU needs to
// stay safe is checked here: syntax and duplicate keys.

class TomlDateTime {
  constructor(text) { this.text = text; }
  toJSON() { return this.text; }
  toString() { return this.text; }
}

export class TomlFloat {
  constructor(value) { this.value = value; }
  toJSON() { return this.value; }
}

const isTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof TomlDateTime);
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const NUMBER = /^(?:[+-]?(?:inf|nan)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)(?=[\s,\]}#]|$)/;
const DATE = /^(?:\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?=[\s,\]}#]|$)/;

/** A cursor over `text` with the value grammar shared by documents and lone inline values. */
function reader(text, { floats = false } = {}) {
  const state = { at: 0 };
  const fail = (what = 'invalid TOML') => {
    const line = text.slice(0, state.at).split('\n').length;
    throw new Error(`${what} at line ${line}`);
  };
  const peek = (count = 1) => text.slice(state.at, state.at + count);
  const space = (newlines = false) => {
    for (;;) {
      const char = text[state.at];
      if (char === ' ' || char === '\t' || (newlines && (char === '\n' || char === '\r'))) state.at += 1;
      else if (newlines && char === '#') while (state.at < text.length && text[state.at] !== '\n') state.at += 1;
      else return;
    }
  };
  const escape = () => {
    const kind = text[state.at + 1];
    if (ESCAPES[kind] !== undefined) {
      state.at += 2;
      return ESCAPES[kind];
    }
    const size = { u: 4, U: 8 }[kind];
    const hex = size && text.slice(state.at + 2, state.at + 2 + size);
    if (!size || !new RegExp(`^[0-9A-Fa-f]{${size}}$`).test(hex)) fail('invalid escape');
    state.at += 2 + size;
    return String.fromCodePoint(parseInt(hex, 16));
  };
  const string = () => {
    const quote = text[state.at];
    if (peek(3) === quote.repeat(3)) return multiline(quote);
    state.at += 1;
    let result = '';
    while (text[state.at] !== quote) {
      if (state.at >= text.length || text[state.at] === '\n') fail('unterminated string');
      if (quote === '"' && text[state.at] === '\\') result += escape();
      else result += text[state.at++];
    }
    state.at += 1;
    return result;
  };
  const multiline = (quote) => {
    state.at += 3;
    if (text[state.at] === '\n') state.at += 1;
    else if (peek(2) === '\r\n') state.at += 2;
    let result = '';
    for (;;) {
      if (state.at >= text.length) fail('unterminated string');
      if (peek(3) === quote.repeat(3)) {
        let extra = 0;
        while (extra < 2 && text[state.at + 3 + extra] === quote) extra += 1;
        state.at += 3 + extra;
        return result + quote.repeat(extra);
      }
      if (quote === '"' && text[state.at] === '\\') {
        const rest = /^\\[ \t]*\r?\n/.exec(text.slice(state.at));
        if (rest) {
          state.at += rest[0].length;
          while (/[ \t\r\n]/.test(text[state.at] ?? '')) state.at += 1;
        } else result += escape();
      } else result += text[state.at++];
    }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      space();
      if (text[state.at] === '"' || text[state.at] === "'") {
        if (peek(3) === text[state.at].repeat(3)) fail('invalid key');
        parts.push(string());
      } else {
        const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(state.at));
        if (!bare) fail('invalid key');
        parts.push(bare[0]);
        state.at += bare[0].length;
      }
      space();
      if (text[state.at] !== '.') return parts;
      state.at += 1;
    }
  };
  const value = (assign) => {
    space();
    const char = text[state.at];
    if (char === '"' || char === "'") return string();
    if (char === '{') {
      state.at += 1;
      const table = {};
      space();
      if (text[state.at] === '}') {
        state.at += 1;
        return table;
      }
      for (;;) {
        const path = key();
        if (text[state.at] !== '=') fail();
        state.at += 1;
        assign(table, path, value(assign));
        space();
        if (text[state.at] === '}') {
          state.at += 1;
          return table;
        }
        if (text[state.at] !== ',') fail();
        state.at += 1;
      }
    }
    if (char === '[') {
      state.at += 1;
      const array = [];
      for (;;) {
        space(true);
        if (text[state.at] === ']') {
          state.at += 1;
          return array;
        }
        array.push(value(assign));
        space(true);
        if (text[state.at] === ',') state.at += 1;
        else if (text[state.at] !== ']') fail();
      }
    }
    const rest = text.slice(state.at, state.at + 64);
    if (rest.startsWith('true') && !/^true[A-Za-z0-9_-]/.test(rest)) {
      state.at += 4;
      return true;
    }
    if (rest.startsWith('false') && !/^false[A-Za-z0-9_-]/.test(rest)) {
      state.at += 5;
      return false;
    }
    const date = DATE.exec(rest);
    if (date) {
      state.at += date[0].length;
      return new TomlDateTime(date[0]);
    }
    const number = NUMBER.exec(rest);
    if (!number) fail('invalid value');
    state.at += number[0].length;
    const word = number[0].replaceAll('_', '');
    if (/^0[xob]/.test(word)) return parseInt(word.slice(2), { x: 16, o: 8, b: 2 }[word[1]]);
    const float = /^[+-]?(inf|nan)$/.test(word) ? (word.endsWith('nan') ? NaN : (word[0] === '-' ? -Infinity : Infinity))
      : /[.eE]/.test(word) ? Number(word) : null;
    if (float === null) return Number(word);
    return floats ? new TomlFloat(float) : float;
  };
  // The rest of the line holds only a comment.
  const end = () => {
    space();
    if (text[state.at] === '#') while (state.at < text.length && text[state.at] !== '\n') state.at += 1;
    if (text[state.at] === '\r' && text[state.at + 1] === '\n') state.at += 1;
    if (state.at < text.length && text[state.at] !== '\n') fail();
    state.at += 1;
  };
  return { state, fail, space, key, value, end, isTable };
}

/** Assign `path` = `value` under `table`, creating the tables a dotted key names. */
function assign(table, path, value) {
  let target = table;
  for (const part of path.slice(0, -1)) {
    if (!Object.hasOwn(target, part)) target[part] = {};
    else if (!isTable(target[part])) throw new Error(`key ${path.join('.')} conflicts with an existing value`);
    target = target[part];
  }
  const last = path.at(-1);
  if (Object.hasOwn(target, last)) throw new Error(`duplicate key ${path.join('.')}`);
  target[last] = value;
}

/** Parse a whole TOML document. */
export function parse(text, options) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const read = reader(text, options);
  const root = {};
  const arrays = new WeakSet();
  let current = root;
  const descend = (path) => {
    let target = root;
    for (const part of path) {
      if (!Object.hasOwn(target, part)) target[part] = {};
      let next = target[part];
      if (Array.isArray(next) && arrays.has(next)) next = next.at(-1);
      if (!isTable(next)) read.fail(`key ${path.join('.')} is not a table`);
      target = next;
    }
    return target;
  };
  for (;;) {
    read.space(true);
    const { state } = read;
    if (state.at >= text.length) return root;
    if (text[state.at] === '[') {
      const array = text[state.at + 1] === '[';
      state.at += array ? 2 : 1;
      const path = read.key();
      if (text.slice(state.at, state.at + (array ? 2 : 1)) !== (array ? ']]' : ']')) read.fail();
      state.at += array ? 2 : 1;
      const parent = descend(path.slice(0, -1));
      const name = path.at(-1);
      if (array) {
        if (!Object.hasOwn(parent, name)) {
          parent[name] = [];
          arrays.add(parent[name]);
        } else if (!arrays.has(parent[name])) read.fail(`key ${path.join('.')} is not an array of tables`);
        current = {};
        parent[name].push(current);
      } else {
        if (!Object.hasOwn(parent, name)) parent[name] = {};
        current = parent[name];
        if (!isTable(current)) read.fail(`key ${path.join('.')} is not a table`);
      }
    } else {
      const path = read.key();
      if (text[state.at] !== '=') read.fail();
      state.at += 1;
      try {
        assign(current, path, read.value(assign));
      } catch (error) {
        if (/ at line /.test(error.message)) throw error;
        read.fail(error.message);
      }
    }
    read.end();
  }
}
