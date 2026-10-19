// Shared entry-point handling for the modules the launchers run directly.
// Builtins come from process.getBuiltinModule, which skips the per-launch cost of an ESM builtin facade.
const { realpathSync } = process.getBuiltinModule('node:fs');
const { fileURLToPath } = process.getBuiltinModule('node:url');

/** True when the module with this `import.meta` is the script Node was started on. */
export function isMain(meta) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(meta.url);
  } catch {
    return false;
  }
}

/** Run `main`; a thrown error prints `<prefix>: <message>` and exits 1, a returned number is the exit status. */
export async function run(prefix, main) {
  try {
    const status = await main();
    if (typeof status === 'number') process.exitCode = status;
  } catch (error) {
    process.stderr.write(`${prefix}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
