# Native-pipe host extraction by structure (2026-10-06)

GitHub issue 13 reported that the Windows installer stopped on OpenAI.Codex `26.930.7945.0` with "Wre no longer exposes the expected native-pipe and turn-cleanup interface". The installer had found the original native-pipe host factory by its minified name, `Wre`. In that release train the name belongs to an unrelated helper, and the real factory depends on many more of the main bundle's declarations.

This record is a macOS bundle check. It makes no Windows live claim: no Windows install, native helper, named pipe or Sky call was exercised.

## Bundle inspected

Installed macOS ChatGPT `26.930.21537` (build 12776), `Contents/Resources/app.asar`, read only. Its main bundle `.vite/build/main-C3nRcJ3D.js` is 3,732,890 bytes with SHA-256 `bd0f6d8d231f255a675404da8ac0d4aade9554ca5266318375a6ed5ee1ee4065`. The Windows build of the same release train bundles the same sources with different minified names, so this is evidence for the layout, not for the Windows names.

## Observed structure

- The factory is one top-level `async function` (`Kne` in this build, 1,969 characters) whose first parameter is an object pattern with `codexCliPath`, `nativePipeDirectory`, `onAnalyticsEvent`, `windowsHelperPath` and `windowsHelperTransportModulePath`. It returns `{pipePath, closeActiveTurn, hasActiveTurn, dispose}`. Two other top-level functions with an options object also mention `nativePipeDirectory` but lack the other native-pipe options, so a text search for the property name is not enough; the structural match is unique.
- It is not self-contained. Its scope-correct closure is 53 top-level pieces (about 10.6 KB with the generated header): zod schemas, constants, helper functions, and the module-level `require` bindings with their interop reassignments (`x = interop(x)`) that those pieces use. The bundle's Electron binding is not part of it. Seven other top-level statements touch needed bindings only through imported modules (zod schema constructions, a logger registration, a property read); they are not carried, because carrying them would reach the Electron-bound bootstrap chunk, and the generated module's header counts them.
- Its relative requires reach 9 chunk files: the rolldown runtime, two `src`, `core`, `zod`, `logger`, `_baseSlice`, `mcp-app-attachment` and `path-browserify-win32` chunks. The previous fixed family list (runtime, `src`, `logger` plus `tslib`) missed the rest.
- Single-letter bindings differ from the old entry's fixed alias map: here `c` is the `path-browserify-win32` chunk and `p` the `src` chunk (the map had `node:url` and `node:os`), `T` is `node:url` (the map had `node:net`) and `R` is `node:crypto` (the map had `node:perf_hooks`).

## Checks run

`python3 scripts/check_windows_host_layout.py /Applications/ChatGPT.app/Contents/Resources/app.asar` located the factory, extracted it with the 9 chunk files into a temporary directory, loaded the generated module in plain Node 26 with `electron` made unresolvable, and called the factory with dummy paths. It returned `closeActiveTurn`, `dispose`, `hasActiveTurn` and `pipePath`; `closeActiveTurn` for an unknown turn returned `false`; `dispose` completed. No `electron` or `better-sqlite3` require was attempted. The thin `windows-pipe-host.cjs` entry, started with dummy helper paths, reported `ready` with its two private pipe names and exited 0 when its stdin closed. Planning takes under one second. Nothing extracted was kept.

The synthetic unit tests in `tests/test_windows_host.py` cover the old self-contained layout, the split layout, shadowed names, and the fail-closed cases. The extracted bytes stay out of Git and out of archives.

## Not verified

A live Windows install on `26.930.7945.0`, named-pipe behavior, the native helper and Sky service on that release, and Windows model-driven use. The reporter offered to test.
