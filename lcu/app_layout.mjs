// Locate the original Codex CLI files in a supported official app layout.
// Builtins come from process.getBuiltinModule, which skips the per-launch cost of an ESM builtin facade.
const { lstatSync } = process.getBuiltinModule('node:fs');
const { join, relative, sep } = process.getBuiltinModule('node:path');

function regularFile(root, path) {
  try {
    if (!lstatSync(path).isFile()) return false;
    let current = root;
    for (const component of relative(root, path).split(sep).slice(0, -1)) {
      current = join(current, component);
      if (!lstatSync(current).isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Return the complete original CLI/host pair `{cli, codeModeHost}` from one known resource layout. */
export function locateCodexTools(resources, { windows = false } = {}) {
  const suffix = windows ? '.exe' : '';
  const matches = [];
  for (const base of ['.', 'codex-cli/bin']) {
    const cli = join(resources, base, `codex${suffix}`);
    const codeModeHost = join(resources, base, `codex-code-mode-host${suffix}`);
    if (regularFile(resources, cli) && regularFile(resources, codeModeHost)) matches.push({ cli, codeModeHost });
  }
  if (matches.length > 1) throw new Error(`Ambiguous original Codex CLI layout in application resources: ${resources}`);
  if (!matches.length) throw new Error(`Application is missing a complete original Codex CLI layout: ${resources}`);
  return matches[0];
}
