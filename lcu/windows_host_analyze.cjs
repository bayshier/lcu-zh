'use strict';
// Structural analysis of the installed app's minified main bundle, run by
// lcu/windows_host.py with the Node that LCU already uses for the Windows host.
// It parses with the vendored acorn parser (lcu/vendor/acorn) and never executes,
// evaluates or rewrites app code: the generated module is a verbatim selection of
// the bundle's own top-level declarations, in their original order.
//
// Request (JSON on stdin):
//   {op: 'host', source}      locate the native-pipe host factory and emit its module
//   {op: 'requires', files}   list the require() specifiers of each {member: source}
// Response (JSON on stdout): {ok: true, ...} or {ok: false, error}.

const {isBuiltin} = require('node:module');
const acorn = require('./vendor/acorn/acorn.js');

const FACTORY_OPTIONS = ['codexCliPath', 'nativePipeDirectory', 'windowsHelperPath',
  'windowsHelperTransportModulePath'];
const FACTORY_MARKERS = ['closeActiveTurn', 'nativePipeDirectory'];

class Unsupported extends Error {}

function parse(source) {
  try {
    return acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'script',
      allowHashBang: true, allowReturnOutsideFunction: true});
  } catch (error) {
    throw new Unsupported(`source does not parse (${error.message})`);
  }
}

function memberRoot(node) {
  while (node && node.type === 'MemberExpression') node = node.object;
  return node && node.type === 'Identifier' ? node.name : null;
}

function patternNames(node, out) {
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const property of node.properties) {
        patternNames(property.type === 'RestElement' ? property.argument : property.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of node.elements) if (element) patternNames(element, out);
      break;
    case 'RestElement': patternNames(node.argument, out); break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    default: throw new Unsupported(`unsupported binding pattern ${node.type}`);
  }
  return out;
}

function collectVars(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'VariableDeclaration':
      if (node.kind === 'var') for (const d of node.declarations) patternNames(d.id, out);
      break;
    case 'BlockStatement': for (const s of node.body) collectVars(s, out); break;
    case 'IfStatement': collectVars(node.consequent, out); collectVars(node.alternate, out); break;
    case 'ForStatement': collectVars(node.init, out); collectVars(node.body, out); break;
    case 'ForInStatement': case 'ForOfStatement':
      collectVars(node.left, out); collectVars(node.body, out); break;
    case 'WhileStatement': case 'DoWhileStatement': case 'LabeledStatement':
      collectVars(node.body, out); break;
    case 'TryStatement':
      collectVars(node.block, out);
      if (node.handler) collectVars(node.handler.body, out);
      collectVars(node.finalizer, out);
      break;
    case 'SwitchStatement':
      for (const c of node.cases) for (const s of c.consequent) collectVars(s, out);
      break;
    default: break;
  }
}

function lexicalNames(statements) {
  const out = [];
  for (const s of statements) {
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') {
      for (const d of s.declarations) patternNames(d.id, out);
    } else if ((s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration') && s.id) {
      out.push(s.id.name);
    }
  }
  return out;
}

function hoistedNames(statements) {
  const out = lexicalNames(statements);
  for (const s of statements) collectVars(s, out);
  return out;
}

function staticString(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

// Scope-aware reference collector. `free` holds every identifier the visited
// code reads or writes without declaring it itself; `written` the written ones.
class Scan {
  constructor() {
    this.scopes = [];
    this.free = new Set();
    this.written = new Set();
    this.requires = new Set();
    this.imports = new Set();
    this.problems = new Set();
    this.memberWritten = new Set();
    this.depth = 0;
  }

  bound(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return true;
    return false;
  }

  ref(name, write) {
    if (this.bound(name)) return;
    // Dynamic code and an escaping `require` hide dependencies from this static analysis.
    if (name === 'eval') this.problems.add('eval, which makes name resolution dynamic');
    if (name === 'require') this.problems.add('a reference to require other than a require("literal") call');
    this.free.add(name);
    if (write) this.written.add(name);
  }

  // Code that runs while the module loads (not inside a function) and assigns to a property
  // path rooted at a free name: the carried closure must either contain it or refuse.
  noteMemberWrite(target) {
    if (target.type !== 'MemberExpression' || this.depth > 0) return;
    const root = memberRoot(target);
    if (root !== null && !this.bound(root)) this.memberWritten.add(root);
  }

  scoped(names, body) {
    if (names.includes('require') || names.includes('eval')) {
      this.problems.add('a binding named require or eval, which hides dependencies');
    }
    this.scopes.push(new Set(names));
    try { body(); } finally { this.scopes.pop(); }
  }

  visit(node) {
    if (!node) return;
    const handler = this['on' + node.type];
    if (handler) handler.call(this, node); else this.children(node);
  }

  children(node) {
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item.type === 'string') this.visit(item);
      } else if (value && typeof value.type === 'string') {
        this.visit(value);
      }
    }
  }

  // Binding patterns: names are declared elsewhere; only defaults and computed keys evaluate.
  declPattern(node) {
    switch (node.type) {
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') { this.declPattern(p.argument); continue; }
          if (p.computed) this.visit(p.key);
          this.declPattern(p.value);
        }
        break;
      case 'ArrayPattern': for (const e of node.elements) if (e) this.declPattern(e); break;
      case 'RestElement': this.declPattern(node.argument); break;
      case 'AssignmentPattern': this.declPattern(node.left); this.visit(node.right); break;
      default: break;
    }
  }

  // Assignment targets: identifiers are written, member targets are evaluated.
  assignPattern(node) {
    switch (node.type) {
      case 'Identifier': this.ref(node.name, true); break;
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') { this.assignPattern(p.argument); continue; }
          if (p.computed) this.visit(p.key);
          this.assignPattern(p.value);
        }
        break;
      case 'ArrayPattern': for (const e of node.elements) if (e) this.assignPattern(e); break;
      case 'RestElement': this.assignPattern(node.argument); break;
      case 'AssignmentPattern': this.assignPattern(node.left); this.visit(node.right); break;
      default: this.noteMemberWrite(node); this.visit(node); break;
    }
  }

  onIdentifier(node) { this.ref(node.name, false); }
  onMemberExpression(node) { this.visit(node.object); if (node.computed) this.visit(node.property); }
  onProperty(node) { if (node.computed) this.visit(node.key); this.visit(node.value); }
  onMethodDefinition(node) { if (node.computed) this.visit(node.key); this.visit(node.value); }
  onPropertyDefinition(node) {
    if (node.computed) this.visit(node.key);
    if (node.value) this.scoped(['arguments'], () => this.visit(node.value));
  }
  onLabeledStatement(node) { this.visit(node.body); }
  onBreakStatement() {}
  onContinueStatement() {}
  onMetaProperty() {}
  onWithStatement() { throw new Unsupported('a with statement makes name resolution dynamic'); }
  // import() of a computed specifier is a runtime path the caller supplies (the host
  // loads its helper transport this way); a literal specifier is a static dependency.
  onImportExpression(node) {
    const spec = staticString(node.source);
    if (spec !== null) this.imports.add(spec);
    this.children(node);
  }

  onVariableDeclaration(node) {
    for (const d of node.declarations) {
      this.declPattern(d.id);
      this.visit(d.init);
      // A nested `var x = ...` outside any function still writes the top-level x.
      if (node.kind === 'var' && d.init) for (const name of patternNames(d.id, [])) this.ref(name, true);
    }
  }

  onAssignmentExpression(node) {
    if (node.left.type === 'Identifier' || node.operator !== '=') {
      if (node.left.type === 'Identifier') this.ref(node.left.name, true);
      else { this.noteMemberWrite(node.left); this.visit(node.left); }
    } else {
      this.assignPattern(node.left);
    }
    this.visit(node.right);
  }

  onUpdateExpression(node) {
    if (node.argument.type === 'Identifier') this.ref(node.argument.name, true);
    else { this.noteMemberWrite(node.argument); this.visit(node.argument); }
  }

  onUnaryExpression(node) {
    if (node.operator === 'delete') this.noteMemberWrite(node.argument);
    this.visit(node.argument);
  }

  onCallExpression(node) {
    if (node.callee.type === 'Identifier' && node.callee.name === 'require' && !this.bound('require')) {
      this.free.add('require');
      const spec = node.arguments.length === 1 ? staticString(node.arguments[0]) : null;
      if (spec !== null) this.requires.add(spec); else this.problems.add('require() with a non-literal argument');
      for (const argument of node.arguments) this.visit(argument);
      return;
    }
    this.children(node);
  }

  onFunction(node) {
    const arrow = node.type === 'ArrowFunctionExpression';
    const expressionName = node.type === 'FunctionExpression' && node.id ? [node.id.name] : [];
    const names = [];
    for (const p of node.params) patternNames(p, names);
    if (!arrow) names.push('arguments');
    this.depth++;
    try {
      this.scoped(expressionName, () => this.scoped(names, () => {
        for (const p of node.params) this.declPattern(p);
        if (node.body.type !== 'BlockStatement') { this.visit(node.body); return; }
        this.scoped(hoistedNames(node.body.body), () => { for (const s of node.body.body) this.visit(s); });
      }));
    } finally {
      this.depth--;
    }
  }
  onFunctionDeclaration(node) { this.onFunction(node); }
  onFunctionExpression(node) { this.onFunction(node); }
  onArrowFunctionExpression(node) { this.onFunction(node); }

  onClass(node) {
    const name = node.type === 'ClassExpression' && node.id ? [node.id.name] : [];
    this.scoped(name, () => { this.visit(node.superClass); this.visit(node.body); });
  }
  onClassDeclaration(node) { this.onClass(node); }
  onClassExpression(node) { this.onClass(node); }
  onStaticBlock(node) {
    this.scoped(['arguments', ...hoistedNames(node.body)], () => { for (const s of node.body) this.visit(s); });
  }

  onBlockStatement(node) {
    this.scoped(lexicalNames(node.body), () => { for (const s of node.body) this.visit(s); });
  }
  onSwitchStatement(node) {
    this.visit(node.discriminant);
    this.scoped(lexicalNames(node.cases.flatMap(c => c.consequent)), () => {
      for (const c of node.cases) { this.visit(c.test); for (const s of c.consequent) this.visit(s); }
    });
  }
  onForStatement(node) {
    const lexical = node.init && node.init.type === 'VariableDeclaration' ? lexicalNames([node.init]) : [];
    this.scoped(lexical, () => {
      this.visit(node.init); this.visit(node.test); this.visit(node.update); this.visit(node.body);
    });
  }
  onForInStatement(node) {
    const lexical = node.left.type === 'VariableDeclaration' ? lexicalNames([node.left]) : [];
    this.scoped(lexical, () => {
      if (node.left.type === 'VariableDeclaration') {
        this.visit(node.left);
        // `for (var x of ...)` outside any function writes the top-level x.
        if (node.left.kind === 'var') for (const d of node.left.declarations) {
          for (const name of patternNames(d.id, [])) this.ref(name, true);
        }
      } else {
        this.assignPattern(node.left);
      }
      this.visit(node.right); this.visit(node.body);
    });
  }
  onForOfStatement(node) { this.onForInStatement(node); }
  onCatchClause(node) {
    const names = node.param ? patternNames(node.param, []) : [];
    this.scoped(names, () => { if (node.param) this.declPattern(node.param); this.visit(node.body); });
  }

  // A whole program (a chunk file) as its own function-like scope.
  program(node) {
    this.scoped(hoistedNames(node.body), () => { for (const s of node.body) this.visit(s); });
  }
}

function classify(spec) {
  return {spec, builtin: isBuiltin(spec)};
}

function problemsOf(scan, where) {
  if (scan.problems.size) {
    throw new Unsupported(`${where} uses unsupported ${[...scan.problems].join(', ')}`);
  }
}

function listRequires(files) {
  const result = {};
  for (const [name, source] of Object.entries(files)) {
    const program = parse(source);
    const scan = new Scan();
    scan.program(program);
    problemsOf(scan, name);
    result[name] = {requires: [...scan.requires].sort().map(classify),
      imports: [...scan.imports].sort().map(classify)};
  }
  return {ok: true, files: result};
}

function isFactory(node) {
  if (node.type !== 'FunctionDeclaration' || !node.id || node.params.length === 0) return false;
  const first = node.params[0];
  if (first.type !== 'ObjectPattern') return false;
  const keys = new Set();
  for (const p of first.properties) {
    if (p.type !== 'Property' || p.computed) continue;
    if (p.key.type === 'Identifier') keys.add(p.key.name);
    else if (p.key.type === 'Literal') keys.add(String(p.key.value));
  }
  return FACTORY_OPTIONS.every(name => keys.has(name));
}

// A top-level statement made only of assignments to (or updates of) bindings or property
// paths rooted at them, such as `v = interop(v);` or `state.value = 1, state.n++;`. Such a
// statement finishes initialising those bindings, so it travels with their declarations.
function initializerRoots(statement) {
  if (statement.type !== 'ExpressionStatement') return null;
  const expression = statement.expression;
  const parts = expression.type === 'SequenceExpression' ? expression.expressions : [expression];
  const roots = [];
  for (const part of parts) {
    let target;
    if (part.type === 'AssignmentExpression') target = part.left;
    else if (part.type === 'UpdateExpression') target = part.argument;
    else return null;
    const root = memberRoot(target);
    if (root === null) return null;
    roots.push(root);
  }
  return [...new Set(roots)];
}

function entriesOf(program) {
  const entries = [];
  const add = (entry, scan) => {
    entry.free = scan.free; entry.written = scan.written;
    entry.requires = scan.requires; entry.imports = scan.imports; entry.problems = scan.problems;
    entry.memberWritten = scan.memberWritten;
    if (entry.names.includes('require') || entry.names.includes('eval')) {
      scan.problems.add('a binding named require or eval, which hides dependencies');
    }
    entry.index = entries.length;
    entries.push(entry);
  };
  for (const statement of program.body) {
    const scan = new Scan();
    if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      scan.visit(statement);
      add({kind: statement.type === 'ClassDeclaration' ? 'class' : 'function', names: [statement.id.name],
        node: statement, text: null}, scan);
    } else if (statement.type === 'VariableDeclaration') {
      for (const d of statement.declarations) {
        const declaratorScan = new Scan();
        declaratorScan.declPattern(d.id);
        declaratorScan.visit(d.init);
        add({kind: statement.kind, names: patternNames(d.id, []), node: d, declaration: statement}, declaratorScan);
      }
    } else {
      scan.visit(statement);
      const roots = initializerRoots(statement);
      add({kind: roots ? 'assign' : 'other', names: roots || [], node: statement}, scan);
    }
  }
  return entries;
}

function hostModule(source) {
  const program = parse(source);
  const matches = program.body.filter(isFactory);
  if (matches.length !== 1) return {ok: true, matches: matches.length};
  const factory = matches[0];
  const factorySource = source.slice(factory.start, factory.end);
  for (const marker of FACTORY_MARKERS) {
    if (!factorySource.includes(marker)) {
      return {ok: false, error: `the native-pipe host factory no longer exposes ${marker}`};
    }
  }
  const entries = entriesOf(program);
  const providers = new Map();
  for (const entry of entries) {
    if (entry.kind === 'assign' || entry.kind === 'other') continue;
    for (const name of entry.names) {
      if (!providers.has(name)) providers.set(name, []);
      providers.get(name).push(entry);
    }
  }
  const assignments = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'assign') continue;
    for (const name of entry.names) {
      if (!assignments.has(name)) assignments.set(name, []);
      assignments.get(name).push(entry);
    }
  }

  const included = new Set();
  const queue = [entries.find(entry => entry.node === factory)];
  included.add(queue[0]);
  const unresolved = new Set();
  const includedNames = new Set();
  const take = entry => {
    if (included.has(entry)) return;
    included.add(entry);
    queue.push(entry);
    for (const name of entry.names) includedNames.add(name);
  };
  for (const name of queue[0].names) includedNames.add(name);
  const others = entries.filter(entry => entry.kind === 'other');
  // An imported module namespace: every declaration of the name calls require().
  const moduleBinding = name => (providers.get(name) || []).every(
    provider => provider.requires.size > 0 && ['let', 'const', 'var'].includes(provider.kind));
  for (;;) {
    while (queue.length) {
      const entry = queue.pop();
      if (entry.problems.size) {
        throw new Unsupported(`a required declaration uses unsupported ${[...entry.problems].join(', ')}`);
      }
      for (const name of entry.free) {
        if (providers.has(name)) {
          for (const provider of providers.get(name)) take(provider);
          for (const assignment of assignments.get(name) || []) take(assignment);
        } else if (name !== 'require' && !(name in globalThis)) {
          unresolved.add(name);
        }
      }
    }
    // Any other top-level statement (a registering or mutating call, a guarded block) that
    // touches a needed binding declared by the app itself runs at load and can initialise
    // state the host relies on, so it is carried verbatim with its own dependencies, under
    // the same refusals. A statement that touches needed bindings only through imported
    // modules (a call into zod, the logger or a Node built-in whose result is discarded)
    // changes state inside modules this installer copies verbatim; carrying it would drag in
    // whatever else it references (the real bundle's reaches the Electron-bound bootstrap
    // chunk), so it is left out and counted in the generated module's header.
    const before = included.size;
    for (const entry of others) {
      if (included.has(entry)) continue;
      if ([...entry.free].some(name => includedNames.has(name) && !moduleBinding(name))) take(entry);
    }
    if (included.size === before) break;
  }
  const uncarried = others.filter(entry => !included.has(entry) &&
    [...entry.free].some(name => includedNames.has(name))).length;
  if (unresolved.size) {
    return {ok: false, error: `the native-pipe host factory needs unresolved identifiers: ${[...unresolved].sort().slice(0, 8).join(', ')}`};
  }
  for (const entry of entries) {
    if (included.has(entry)) continue;
    for (const name of entry.written) {
      if (includedNames.has(name)) {
        return {ok: false, error: `binding ${name} is reassigned by code outside the native-pipe host's dependencies`};
      }
    }
    for (const name of entry.memberWritten) {
      if (includedNames.has(name)) {
        return {ok: false, error: `a property of ${name} is assigned by top-level code outside the native-pipe host's dependencies`};
      }
    }
  }

  const ordered = [...included].sort((a, b) => a.index - b.index);
  const first = program.body[0];
  const strict = first && first.type === 'ExpressionStatement' && first.directive === 'use strict';
  const pieces = ['// Generated by LCU from the installed app: verbatim top-level declarations the native-pipe',
    '// host factory depends on, in their original order. Not part of the LCU archive or Git.'];
  if (uncarried) {
    pieces.push(`// ${uncarried} top-level statement(s) that only call into imported modules were not carried.`);
  }
  if (strict) pieces.push('"use strict";');
  const specs = new Set();
  const imports = new Set();
  for (const entry of ordered) {
    for (const spec of entry.requires) specs.add(spec);
    for (const spec of entry.imports) imports.add(spec);
    let text = entry.kind === 'let' || entry.kind === 'const' || entry.kind === 'var'
      ? `${entry.kind} ${source.slice(entry.node.start, entry.node.end)};`
      : source.slice(entry.node.start, entry.node.end);
    if ((entry.kind === 'assign' || entry.kind === 'other') && !/[;}]$/.test(text)) text += ';';
    pieces.push(text);
  }
  pieces.push(`module.exports = ${factory.id.name};`, '');
  return {ok: true, matches: 1, factory: factory.id.name, uncarried, module: pieces.join('\n'),
    requires: [...specs].sort().map(classify), imports: [...imports].sort().map(classify)};
}

function main(request) {
  if (request.op === 'host' && typeof request.source === 'string') return hostModule(request.source);
  if (request.op === 'requires' && request.files && typeof request.files === 'object') {
    return listRequires(request.files);
  }
  throw new Unsupported('unknown analyzer request');
}

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  let response;
  try {
    response = main(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    response = {ok: false, error: error.message};
  }
  process.stdout.write(JSON.stringify(response));
});
