# Original settings, permission UI and browser shell integration

This audit covers upstream package `26.915.31945`. Exact source ranges and hashes
are recorded in [browser-shell-source-audit.json](verification/browser-shell-source-audit.json).
Bundling these sources does not establish that every surrounding application
service is connected or tested.

## Settings hydration

The original bootstrap `vD` class is the desktop settings store; `OD` creates its
global state store. `vD.initialize({config, batchWriteConfigValues})` is its only
configuration hydration API. There is no reload or refresh method. It preserves
pending writes, reconciles known setting values, compares subscribed values,
emits change notifications and persists pending migrations.

The original application calls `settingsStore.initialize` once after
`getUserSavedConfiguration()`. That app-server wrapper sends
`config/read` with `{includeLayers:false,cwd:null}` and returns `result.config`.
No subsequent desktop-store hydration from a configuration notification was
found in the original main, bootstrap or shared module. Reinitializing it after
an account or network-requirements update uses the original reconciliation
method, but that trigger is an additional standalone integration behavior.

The LCU adapter retains the original settings store, keymap reader, preferred
download directory, download prompt preference, annotation-hostname subscription
and default-browser check. The original application samples
`app.isDefaultProtocolClient('https')` into its shared repository at construction;
LCU also samples it at construction.

`tests/iab_settings.py` verifies actual native `config/read` and
`config/batchWrite`, schema rejection, keymap loading, change notification and
reopening. Its independent TOML assertions also check that approval and sandbox
configuration remain unchanged. Run with `--release ROOT` to exercise the
candidate's adapters, rather than the checkout's adapters. The ARM64 development
run passed. The original first-run migration additionally wrote
`desktop.followUpQueueMode="steer"`; this is upstream behavior, not an LCU policy.

## Website permission UI

The original `sn` component in `button-3b7641138a7c.js` renders website permission
prompts and forwards responses through the browser host. Its `vn=500` guard
ignores input immediately after opening or focus. This code remains unchanged.

`tests/iab_permissions.py ROOT OUTPUT` uses private profiles, an offline HTTP
page and a GTK-owned clipboard. It observes original button geometry through a
test-only DevTools endpoint, clicks the actual page and permission buttons with
Xlib/XTest, and verifies the page's independent HTTP report. It never invokes a
permission grant API or the host's permission-response IPC directly.

The ARM64 development run exercised both Allow and Block. Early clicks at about
62ms and 67ms left the prompt open with no page result. Subsequent clicks after
the original guard returned the seeded clipboard text or `NotAllowedError`.
This covers clipboard permission UI, not all permission types. A later x86-64
fixture uses a persistent parent-renderer DevTools session and waits for the
actual trusted click capture after X11 dispatch, avoiding an observation race.
Captured early clicks at 54.7 ms and 57.0 ms left the prompt unresolved; later
clicks produced the independent Allow/Block outcomes. The original 500 ms guard
was unchanged. Fresh archive gates remain required.

## Deep-link routing

Original bootstrap `dk` (export `y`) owns the queue. Its synchronous
`queueCodexDeepLinkUrl` function parses with `UO`, queues a recognized route and
flushes through `navigateToRoute` after a real window exists. The native browser
calls that queue for connector OAuth callbacks and recognized application links.
The queue, parser and main `Lrt` route dispatcher are all present locally.

For `connectorOAuthCallback`, `Lrt` sends `connector-oauth-callback` to the
application renderer. The actual consumer is `bul`/`pul` in
`app-initial-430deae5a13a.js`. It requires pending OAuth state, matching callback
owner, account identity, expiry/claim validation, and app/plugin resume services.
Forwarding a URL to an account-read API cannot replace that state machine.

The standalone host now constructs an original `dk` queue for each live owner.
Its trusted `BrowserHost.deliver_deep_link(session_id, url)` library method sends
the URL through the private host pipe, requires an existing owner, and receives
an acknowledgement for that owner and request ID. Acknowledgement means only
that the original parser accepted the callback for the queue. The queue sends
the original `connector-oauth-callback` message to that owner's renderer. The
renderer mounts original `pul`/`bul` hooks within its account and query scopes;
`bul` performs the claim, account checks, callback HTTP request and applicable
resume work. Its `Wv.safePost` uses `ZH.httpFetch`, backed by the original main
`wEe.fetchHttp` and original shared `Sf` per-window provider. The IPC adapter
passes headers first and exposes an owner-bound pull/cancel/dispose stream to
the renderer's `Response`. Each renderer pull reads one chunk from the original
`Sf` response body; the body is not buffered before delivery. Cancellation
before headers or during body reading aborts the original provider. Original
fetch errors pass through the same boundary. Queue acceptance still does not
establish OAuth success.

The private owner-bound `BrowserHost.register_app_connect_oauth` operation
passes caller-supplied initiation parameters to the original
`markAppConnectOAuthPending` hook. The caller must obtain a real redirect URL
from the app-connect initiation flow; the host does not invent an account,
OAuth state or callback URL. The matching clear operation passes the caller's
state selector to original `clearPendingAppConnect`. An operation acknowledgement
reports registration or clear processing only, never external OAuth success.

On Linux, the original `dk` receives startup arguments through `queueProcessArgs`
and later arguments through `queueSecondInstanceArgs` after Electron's single
instance lock. Its `registerProtocolClient()` calls
`app.setAsDefaultProtocolClient('codex')`. LCU does not call that method. An
explicit session-specific desktop handler forwards an OS callback through a
same-user private Unix socket to an already running `BrowserHost`, which invokes
its existing `deliver_deep_link(session_id, url)` path. The original `dk` parser,
queue and renderer OAuth hooks still process the callback. The socket exists
only while that session owner is live, is mode `0600` under a mode `0700`
directory, and checks the Linux peer UID. An unavailable owner fails closed.

To prepare an opt-in handler for a known real agent session, run
`lcu browser protocol install --session-id SESSION_ID`. This only writes a
session-specific desktop entry. To choose it as this Linux account's current
`codex://` handler, run the printed `xdg-mime default ...` command, or use
`lcu browser protocol install --session-id SESSION_ID --set-default`. A later
selection for a different session replaces that association; LCU never guesses
between simultaneous owners. Keep the handler selected for the session that
initiated OAuth. Queue acknowledgement means the original queue accepted the
URL, not that an authenticated OAuth exchange completed.

The owner removes its socket on shutdown. A pre-existing socket path blocks
startup, even if no process accepts it; inspect the path and the owner process
before manually removing a stale socket. LCU never deletes an unverified
pre-existing path. The adapter caps active protocol clients and times out
incomplete requests.

`tests/iab_protocol.py` runs in an isolated Linux desktop home with no real
credentials. On both ARM64 and x86-64, it seeded an existing `codex://`
association, verified that handler installation preserved it, selected the LCU
entry explicitly, and used `gio open` to deliver a callback to a live owner.
It observed the original queue's acknowledgement through the owner bridge,
then checked another owner's isolation, a second handler invocation, invalid
route rejection, shutdown cleanup and missing-owner failure. Focused
`tests/test_protocol.py` checks occupied and replaced socket paths, idle-client
expiry and the connection cap. These checks do not establish OAuth account
success or delivery by every Linux desktop environment.

The original in-app browser intercepts its own `codex://` OAuth navigation
through `windowManager.queueCodexDeepLinkUrl`; this can choose the owner only
when exactly one live standalone owner exists. With several owners, the caller
must use explicit session-bound delivery.

`tests/iab_http.cjs` runs the unchanged original HTTP wrapper and provider in
offline ARM64 Linux against fixture network bytes. It verifies a successful
response, denial followed by recovery, cancellation before headers and during
body reading, the renderer adapter receiving the first chunk before EOF, and
owner disposal. A real BrowserWindow/preload IPC round trip also receives its
first chunk before EOF and cancels the original stream. `tests/iab_deep_links.cjs`
uses two actual Electron windows to verify original parsing, queue isolation,
invalid URLs and route errors. The installed-candidate `tests/iab_host.py` gate
also invokes the mounted original pending hook through the private owner IPC:
an empty redirect URL is rejected and a clear selector is processed, without
inventing an account or callback. These offline checks do not establish
authenticated OAuth completion, a pending record created by the original
app-connect UI, or external OAuth service availability; those require a
signed-in live account and service.

## Browser shell commands

Original main `DGe` already handles browser keyboard input. It delegates owner
commands and uses `_U`/`vU`/`yU` plus `getAppShellShortcutState` to resolve the
active panel and whether a tab can close. Returning `null` for that state loses
behavior such as the owner-tab close path, even when `DGe` itself is retained.

`Wc` in `tab-content-b70d652be669.js` is the comment overlay. The exported `Hm`
(`BrowserThreadPanelTab`) wraps `lm`, which contains the full browser panel,
address bar, navigation, find controls and command registration. `ku`/`Au`
connect the original permission subscription and component. `Rm` initializes
`lm`'s dependencies; the module's existing `qm()` initialization already reaches
it. Reusing `lm` through an appended export can avoid the app-wide panel-layout
wrapper while preserving the complete browser-panel implementation.

The standalone host now forwards the original `app-shell-shortcut-state-changed`
event from `LcuAppShellLayout` to its owner-bound window state. While one
original right-panel page is visibly presented, it reports that actual route
and close availability to `_U`/`vU`/`yU`. The original `BrowserHost` still
resolves the focused page and performs navigation, Find, and tab closure.

The original Find UI is `THe.Surface` in the pinned
`app-primary-1ee15bca6237.js`. It is mounted in the existing app/store
contexts. Its `JVe` controller calls the original `BrowserHost.runPageCommand`
through a route-checked local IPC bridge. The standalone native menu takes
the three Find accelerators from the original `Frt` expression and close-tab
accelerators from `BrowserHost.ownerCommandAccelerators`, which comes from the
original keymap state. Its callbacks call the original focused-page command
methods. This owner menu matters on Linux because native Ctrl+W reaches the
owner window rather than the guest `before-input-event`. The extractor records
the Find expression's byte range and hash in `host/iab/derivation.json`.

`tests/iab_commands.py ROOT OUTPUT` runs against an installed release in a
private desktop. The test-only fixture reads DOM geometry, then sends X11
mouse and key input. It verifies address navigation, Back, Next, Reload, Find
and Ctrl+W close. The Find proof checks the original visible `1 / 3 results`
counter and the host's three matches. The close proof checks the original
browser API has no tabs and the window has no webview. An ARM64 development
run passed with the regenerated original provider; final archive gates remain
the release procedure's responsibility.
