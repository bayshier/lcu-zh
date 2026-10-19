# Final macOS thin archive verification, 2026-09-24

Source was the clean integration checkout at commit `d862ea71123b90010381d1434a545f2c0cbd26fc`. On Apple Silicon macOS, `python3 -B scripts/build_bundle.py --platform darwin --app /Applications/ChatGPT.app --output /private/tmp/lcu-final-macos-d862ea7` built `/private/tmp/lcu-final-macos-d862ea7/lcu-0.3.0-darwin-arm64.tar.gz`. SHA-256, matching its sidecar: `93a3adaa27b082ca2e1bc38441d53c00626e0540a56e9f6fbf79ccb698f59dc3`. The 5.2 MB archive has no `ChatGPT.app`, `cua_node`, or `references/upstream` paths. The official app is selected locally, not redistributed.

The extracted archive's `scripts/install.sh --prefix /private/tmp/lcu-final-macos-install-d862ea7 --runtime-only --existing-app /Applications/ChatGPT.app --offline --skip-system --yes` passed. The selected executable is `/private/tmp/lcu-final-macos-install-d862ea7/current/bin/lcu`. It reported pinned ChatGPT 26.917.62051 and CUA 0.0.16/20260915001755-492f19756c31. The installed signed app remained in place.

Against that selected release, the following no-GUI checks passed:

- `tests/macos_setup.py`: disposable Codex registration, original hooks and MCP policy, byte-identical macOS references, config preservation, and bootstrap-only export.
- `tests/macos_session.py`: direct-original versus LCU MCP initialization, tool schemas/descriptions, macOS first-use guide, persistent pure JavaScript, and `js_reset`.
- `tests/macos_cold_path.py`: direct-original versus LCU trusted `launchServices` and `nativePipe` availability, with a verified nonexistent `.app` path rejected before GUI launch.
- Real Pi `configure(['pi'], ...)` in disposable `/private/tmp/lcu-pi-macos-final-d862ea7` registered the generated wrapper and selected command through Pi's own installer. A model-free Pi event fixture loaded that **generated wrapper**, registered `js` and `js_reset`, received the original MCP instructions, executed `nodeRepl.write(7*6)` through `js` and got `42`, then closed the session. This proves the installed wrapper path and pure-JavaScript bridge. It is not a real Pi model turn.

No provider action, personal configuration write, Chrome extension install, new GUI action, or helper termination occurred in this final-archive verification. The prior live TextEdit check reused an already running signed helper. Fresh helper startup and first-use OS permissions remain unverified; the missing-path probe does not claim otherwise.
