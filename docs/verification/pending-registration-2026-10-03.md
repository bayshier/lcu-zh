# Registration of harnesses installed later (verification, 2026-10-03)

Scope: `lcu setup --allow-missing`, `lcu setup --reconcile` and the `pending` list in `setup.json` and `lcu status --json` (see [Harnesses installed later](../INSTALLATION.md#harnesses-installed-later)).

## What the checks establish

- `tests/test_setup_pending.py` (21 tests, Python, mocked registration): the state schema (an old file without the new fields loads with nothing pending; malformed pending is rejected), `--allow-missing` outcomes (missing harnesses recorded and exit 0, Codex and Claude Code still registered, a real failure exits nonzero and the retry command keeps the flag, an explicit registration clears a pending entry, a later `--approval` updates the saved mode and keeps pending), and reconcile (silent no-op without lock or subprocess, pending to registered with the saved audio, approval, scope and session, idempotence, partial failure keeps only the failed harness pending, harnesses that are not pending are untouched, a held setup lock blocks it and the waiter then finds nothing to do).
- `tests/pending_registration.py` (disposable container, real registration, runs from `tests/offline.sh` after `tests/registration.py`): as a fresh account whose `PATH` hides the image's Pi, `setup --agent all --allow-missing --approval auto` registered Codex (with `default_tools_approval_mode`) and Claude Code (`mcp__lcu` allowed), wrote nothing for Pi, and recorded Pi, OMP and Hermes as pending; `status --json` reported them; `--reconcile` with nothing installed printed nothing and left `setup.json` byte-identical; after the real Pi launcher was placed in `~/.local/bin`, `--reconcile` ran `pi install` through Pi itself (the package appears in `~/.pi/agent/settings.json`), left OMP and Hermes pending, and a second run was silent.

## Not verified

- OMP and Hermes registration after a later install ran only against mocked CLIs in the unit tests; no real OMP or Hermes was installed in the container.
- Behavior of a real Claude Code or Codex CLI installed after LCU wrote its configuration (the first-launch merge of `~/.claude.json`, the Codex hook trust hash across CLI versions) was not run.
- No login or boot trigger was exercised; reconcile was run by hand.
- Windows setup was not run.
