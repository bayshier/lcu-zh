# Final four-platform archive gate (2026-09-25)

The four thin archives were built from clean source commit
`66bb0fb0dd2235dd83ab35e7ac468a985fc0b77f`. The immutable outputs are under
`dist/66bb0fb0dd2235dd83ab35e7ac468a985fc0b77f/` in the project checkout.
All four builds completed. The member audit found no first-party source
mismatches or missing source files, upstream payload names, or broken installed
document links. Each archive's SHA-256 sidecar matched, and each extracted
bundle passed its seal check.

| Archive | SHA-256 |
| --- | --- |
| `linux-arm64/lcu-0.3.0-linux-arm64.tar.gz` | `bcb47d9619cfe039dfbe48155e72ca0c85b59871e18e8c307a3e3a8542762d1f` |
| `linux-x64/lcu-0.3.0-linux-x64.tar.gz` | `629b8b5a57b0cf6959a2da0aa29d33a4f077d0ee0178bd88af331dc398bb0c9d` |
| `darwin-arm64/lcu-0.3.0-darwin-arm64.tar.gz` | `a56cc54b0c45d214391c349e4a161d7458c090c246db159d670344ad3b0392bd` |
| `windows-x64/lcu-0.3.0-windows-x64.zip` | `f5b66fe303999cd24703ca33c003e0d35ad918c0805ac9edd1ce6b7d06908d67` |

The first parallel offline attempt verified both sidecars but Docker ended
with exit 125 and `error waiting for container: unexpected EOF`. Read-only
status reported OrbStack `Stopped`, with its Docker API socket absent even
after one normal app launch. The installed `orbctl start` command would resume
machines that were running when OrbStack last stopped, so it was not used.
Those initial failures are preserved in
`/private/tmp/lcu-final-offline-gate-failure-66bb0fb.txt`.

After Docker became available, the existing offline gates passed serially
against the same immutable archives, supplied local packages and disposable
images, with `--network none`. Both sidecars verified; each run completed
installation, failure/rollback and concurrent-installer checks, **142 Python
tests**, agent registration checks and the desktop integration test with exit
0. Logs are `/private/tmp/lcu-offline-arm64-rerun.log` and
`/private/tmp/lcu-offline-x64-rerun.log`. No archive was rebuilt or modified.

Historical `b11ae52` Linux archives had their own 120-test offline gates,
recorded in [the earlier archive report](final-linux-gates-2026-09-24.md).
Those results are separate from this final archive run.

Live platform evidence also has separate boundaries. A subsequent
[fresh macOS guest check](macos-fresh-guest-2026-09-24.md) passed cold helper
startup, first-use permissions, and an exact native TextEdit save verified by
an independent guest read. Windows candidates c, d and f collectively passed
the documented native, lifecycle, setup and official-extension checks, but
Windows model use and automatic browser per-turn cleanup remain unverified. Claude Code's
per-turn lifecycle hooks remain unwired. These archive builds are local
verification artifacts, not published releases.
