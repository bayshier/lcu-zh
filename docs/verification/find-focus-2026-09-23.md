# Linux x64 native Find focus evidence

The native Find command test now waits for Reload's main frame to finish, waits for the original Find input to receive focus after Ctrl+F, and then retains the three-match assertion. The failure path records the native focused window, active owner element, Find input value, loaded page text, original `findState`, and Electron `found-in-page` events.

The pinned original renderer source requests focus with `window.requestAnimationFrame(iHe)` after the Find command updates state. `iHe` focuses and selects `#content-search-input`; `YVe` mounts the original browser Find controller with that input ID. The original main process routes Ctrl+F through `runFocusedVisiblePageCommand`, which checks the focused visible page, focuses the owner window, and opens Find.

An exact amd64 rerun still failed intermittently after the reload-completion barrier. Two of three focused repeats timed out waiting for the Find input to focus; both showed the original Find surface mounted, the `<webview>` still active, an empty query, and `findState` with zero matches. One repeat passed the full address, Back, Next, Reload, Find, and Close workflow. This leaves a possible adapter or original-event timing gap unresolved. The test preserves the Ctrl+F autofocus expectation and does not mask it with a click or timeout increase.

Evidence is under `/private/tmp/lcu-parity-releasegate-hxkg3p_6/x64/continuation/find-diagnostics/` and `/private/tmp/lcu-parity-releasegate-hxkg3p_6/x64/continuation/find-completion-repeats/`. The original extracted primary source used for source inspection is `/private/tmp/lcu-find-primary-source.js`.
