# Linux window-targeted input: measurements and LCU 0.8.3 translation

Date: 2026-10-02. Supports the [Linux window-targeted input adaptation](../STANDALONE-ADAPTATIONS.md#linux-window-targeted-input-reason-and-removal-criterion). All runs used disposable Ubuntu 24.04 containers with local fixtures; no real harness configuration, account or desktop was used, and no OpenAI binary is redistributed.

## Measurement (LCU 0.8.2 and ChatGPT 26.928.31416, CUA 0.0.27)

Native linux/arm64 Docker, Xvfb 1280x800 with XTEST, Xfwm4 4.18, a D-Bus session with AT-SPI, and the original `node_repl` sandbox active. Driven through LCU's stdio MCP `js` tool. Every observation is a file, an AT-SPI text and caret offset, or a DOM event posted by the fixture, never a call's success. Each trial first seeded state with plain XTEST, then ran the action on the path under test.

W is the window-targeted path (`app.pressKey`, `app.click`, `app.scroll`, `app.drag` with a window, which the engine sends with `XSendEvent`). D is `sky.activate_window` followed by the desktop-level `sky.*` call with screen coordinates (XTEST). `ok` means the oracle changed, `NO` means the call succeeded and nothing happened.

| App (toolkit) | keys | click | scroll | drag |
| --- | --- | --- | --- | --- |
| GTK 3 fixture, gedit 46.2 | W ok, D ok | W ok, D ok | W ok, D ok | W ok, D ok |
| **GTK 4 fixture, gnome-text-editor 46.3** | **W NO**, D ok | **W NO**, D ok | **W NO**, D ok | **W NO**, D ok |
| Qt 5 (PyQt5 5.15.13), Qt 6 (PyQt6 6.4.2) | W ok, D ok | W ok, D ok | **W NO**, D ok | W ok, D ok |
| Java 21 Swing | W ok only if already focused, D no right after `activate_window` | W ok, D ok | W ok, D ok | W ok, D ok |
| Firefox 157, Chrome for Testing 153, Electron 44 | W ok, D ok | W ok, D ok | W ok, D ok | W ok, D ok |
| xfce4-terminal (VTE) | W ok, D ok | W ok, D ok | W ok, D ok | not applicable |

- Only the whole GTK 4 toolkit ignored window-targeted keys, clicks, scroll and drag, and only Qt ignored scroll. Browsers, Electron, GTK 3 and the terminal also worked unfocused and occluded, without raising or focusing the target.
- Raw delivery (a core-only Xlib window logging events): the engine's window-targeted click arrives as a `ButtonPress` with `send_event=1` at the given coordinates; the same action through the desktop path arrives with `send_event=0` at `window.x + x`, `window.y + y`. GTK 4 reads XInput2 only, so it never sees the `XSendEvent` core events.
- `sky.list_windows` returns `{id, x, y, width, height, focused, modal, window_type, title, app}`; `x, y` is the X client origin, equal to `xwininfo`'s absolute upper-left and excluding the Xfwm4 frame. Window-targeted coordinates are client relative, so the desktop point is `(window.x + x, window.y + y)`. A GTK 3 client-side-decorated window reported a shadow-including origin (`-26,-23` for gedit) that is still consistent with that window's own coordinates. HiDPI (`GDK_SCALE=2`) uses device pixels on both paths, so no scaling is applied.
- `activate_window` succeeded within 20 to 30 ms for every app under Xfwm4 and `list_windows().focused` agreed. Java (Globally Active focus) drops keyboard focus when an already active window is activated again, which is why the translation never activates a window that is already focused and never touches Java.
- A modal GTK dialog is listed as its own window (`modal: true`, focused) and the parent as unfocused. A window-targeted key to the parent did nothing, and activating the parent did not help a following desktop key (the toolkit's grab); the dialog must be the target.
- `typeText` is AT-SPI only: it works for GTK 3, GTK 4 and Qt (with accessibility on), and errors with "no AT-SPI provider" for Firefox, Chromium, Electron, Java and VTE. gedit 46.2 segfaulted on AT-SPI text insertion with either path (a separate bug, not changed here).
- Controls: plain `xdotool` works everywhere; `xdotool --window` (also `XSendEvent`) is ignored by GTK 3 and GTK 4 but accepted by Qt, Firefox, Chromium, Electron and Java.

Not measured: fractional scaling, other window managers or compositing, real Google Chrome (Chrome for Testing stood in), an Electron app beyond a minimal page.

## What 0.8.3 does

`lcu/linux_sky_service.mjs` is the `sky` trusted service on Linux. It forwards to the original Sky service and, for window-targeted `key`, `click`, `scroll`, `drag`, `move`, `key_down` and `key_up` on a GTK 4 process (and `scroll` on a Qt process), activates the target if it is not focused and issues the engine's desktop-level call with converted coordinates. The process is identified by `_NET_WM_PID` and `/proc/<pid>/maps` (`libgtk-4.so`, `libQt5Core.so` or `libQt6Core.so`; a process that also maps `icudtl.dat`, `libxul.so` or `libffmpeg.so` is not GTK 4). Details and limits: [adapters](../ADAPTERS.md#linux-window-targeted-input).

## Tests

`tests/gtk4_input.py` and `tests/gtk4_surface_fixture.py` (GTK 4: keys, chords, held modifier, click on an unfocused window, scroll offset, drag displacement, a modal dialog, a missing window, `LCU_LINUX_INPUT_TRANSLATION=off`), `tests/linux_input_controls.py` with `tests/qt_fixture.py` (GTK 3 click, a core-event X11 window, Qt keys and click, a Chromium-like process, Qt scroll translated and untranslated with the opt-out control; the focused window stays the same wherever the original path is kept) and `tests/adapter_paths.py` (GTK 4 window-targeted keys and click through the bare client, Codex relay, Claude relay, the Pi/Oh My Pi shared client and the Hermes bridge). `tests/codex_mcp_env.py` records that Codex CLI 0.159.1 drops an LCU variable from its own environment and passes one set under `[mcp_servers.lcu.env]`, directly and behind the relay.

Gate results are in the [0.8.3 release notes](../releases/0.8.3.md).

## 0.8.4: review findings fixed

A review of 0.8.3 found seven defects in the translation. The service-level ones were reproduced before the fix with an in-memory fake desktop (`adapters/test/linux-sky-service.test.mjs`: window list and focus, desktop-level input with a held-key model, `xprop` and `/proc`), which failed 14 of 19 cases against the 0.8.3 logic:

1. Planning ran before serialization on a stale focus snapshot: concurrent requests to B then A activated B and then sent A's key to B. Planning, activation and verification now all run inside the queue, the focus is verified immediately before sending, and a mismatch is an error.
2. Translated holds lost their release routing: after the target closed or minimized, `key_up` became a window-targeted no-op and the desktop key stayed down, and `down(A,shift) down(B,shift) up(A,shift)` released B's. Holds are tracked per (target, chord) with per-key owner counts and always released at the desktop level; the effect oracle is a later desktop `k` typed in lowercase.
3. A stale point could click another application: the start point of pointer actions is validated against the target's current client rectangle.
4. Modal redirection kept the parent's geometry: it is now keyboard only, and pointer input to such a parent is an error naming the dialog.
5. A caller-supplied `NODE_REPL_TRUSTED_SERVICES` (`{}` or custom-only) received an added `sky` entry: supplied maps are now kept verbatim unless they name the original Sky service.
6. The toolkit cache survived PID reuse: it is keyed by (PID, `/proc/<pid>/stat` start time) and revalidated.
7. `_NET_WM_PID` of a window from another machine or PID namespace was trusted: `WM_CLIENT_MACHINE` must equal the local host name and `/proc/<pid>/ns/pid` must equal LCU's own, otherwise the request is untouched.

The desktop suites gained a hold released after its window closed (the stuck-shift effect oracle), refused pointer input to a modal parent and an out-of-bounds click refusal. Gate results are in the [0.8.4 release notes](../releases/0.8.4.md).

Correction (0.8.5): the sentence in the 0.8.4 notes that translated holds were "always released" was wrong for several cases (see below); 0.8.5 removes hold translation instead of patching it.

## 0.8.5: smaller translation, authoritative process identity

A second review of 0.8.4 found: partial chord releases left modifiers stuck (the original engine owns complete chords, a token-subset release did not release the chord it acquired, and the in-memory fake had masked it by splitting chords itself); focus-changing original calls (`activate_window`, desktop-level input) and pass-through fallbacks bypassed the queue, so a key could still land in another window; turn cleanup left translated holds active; key aliases (`Shift` against `Shift_L`) bypassed owner counts; a failed release lost its retry routing; and a client sharing the X server from another PID namespace (Flatpak, containers) advertises a namespaced `_NET_WM_PID` that can collide with an unrelated local process. 0.8.5 shrinks the feature instead of patching hold bookkeeping again:

1. `key_down` and `key_up` are no longer translated and the hold-ownership code is gone. A held key on a GTK 4 window behaves as in the original engine (ignored); the workaround is the desktop-level hold after `activate_window`. `press_key`, `click`, `scroll`, `drag` and `move` stay translated.
2. Every call that can change focus or input state goes through the one queue, including `activate_window`, desktop-level input, `typeText` and pass-through fallbacks; only `list_windows`, `list_apps`, `get_screenshot` and `get_window_state` bypass it. The final focus check stays immediately before the desktop-level call.
3. Process identity comes from the X server: X-Resource `XResQueryClientIds` with `XRES_CLIENT_ID_PID_MASK` (the `SO_PEERCRED` id; nothing for a remote client) must equal `_NET_WM_PID`, with the PID namespace and start-time checks kept. Any other outcome fails closed. Observed on Ubuntu 24.04 (aarch64 container, Xvfb with the X-Resource extension): the query returned the creating process's id for its window, and without `libxres1` the helper fails and the request passes through. `libxres1` is added to `SYSTEM_PACKAGES` (and the test image); Silo's image needs it, otherwise translation is off and GTK 4 windows behave as in the original engine.

The in-memory fake now follows the engine's chord semantics (a chord presses its keys in order and releases all of them, held or not) and models the X server's record; new cases cover untranslated `key_down`/`key_up`, an `activate_window` racing a translated key in both orders, pass-through serialization, read-only calls bypassing the queue, a Flatpak-like client whose `_NET_WM_PID` collides with a local GTK 4 process, a remote client and a missing X-Resource record (6 of the 23 cases fail against the 0.8.4 logic). `tests/gtk4_input.py` gained native checks for the pass-through of `key_down`/`key_up`, the `activate_window` race and a desktop-level key issued together with a translated one. Gate results are in the [0.8.5 release notes](../releases/0.8.5.md).

## 0.8.6: overlays, hung calls, namespace proof

A third review of 0.8.5 found five defects, each reproduced against the 0.8.5 logic with the in-memory fake before the fix (7 of the 9 new cases failed; the hung-call cases only ended through the test timeout):

1. P1: a non-focusing overlay (notification, tooltip, override-redirect popup) could cover a keyboard-focused GTK target. Activation was skipped, the bounds check passed, and the XTEST click landed on the overlay. Immediately before a translated pointer action (click, double click, scroll, a drag's start, move) the helper now asks the X server for the chain of mapped windows at the converted point (`XTranslateCoordinates` down from the root) and requires the target to be in it; any other window, or no answer, is an error and nothing is sent. `ADAPTERS.md` no longer says the target "is raised" (an already-focused window is not).
2. P2: one hung original call blocked every queued call forever (the original service and its Linux transport have no request timeout). Each call the queue makes is now bounded (30 s). On a timeout LCU stops the trusted worker process, which ends the `sky_linux` engine process (the original transport kills its child on exit; `node_repl` reports a worker exit and starts a fresh worker), and refuses everything queued behind it without sending it. Racing a timeout alone was rejected because the abandoned call could still deliver later.
3. P2: SO_PEERCRED ids are relative to the X server's PID namespace, so LCU in a child namespace with the X server outside could match a collision. The helper first queries X-Resource for its own client (a 1x1 window it never maps) and requires the id to equal `getpid()`. No cache: the proof is one extra round trip in the same single-shot helper, so it cannot go stale across a server restart.
4. P2: an unreadable `/proc/self/ns/pid` failed open; it now fails closed.
5. P3: untranslated requests (a Qt key, Chromium, hidden or foreign windows) started the Python helper before the method check; the toolkit and method are now decided first.

Tests: 32 in-memory cases (9 new: overlay at the point for every pointer method, unknown pointer check, the point asked about, hung activation with refused queued input and no interleaving, hung pass-through, a call answering in time, unreadable own namespace, a server whose helper proof fails, no helper start for untranslated requests); `tests/gtk4_input.py` gained a real override-redirect overlay (`tests/x11_overlay_fixture.py`) over the focused GTK 4 button; `tests/linux_input_hang.py` stops the real engine with SIGSTOP; `tests/linux_xres_namespace.py` runs the helper against a real Xvfb from the same namespace (reports the owning process) and from a child PID namespace (reports nothing; run where `unshare` is permitted, otherwise it prints a notice). Gate results are in the [0.8.6 release notes](../releases/0.8.6.md).


## 0.8.7: drag budget and release, pointer grabs, socket-based namespace proof

Findings fixed (lines at `d6db28d`):

1. P2: a timeout during a translated drag (a valid long drag exceeding 30 s, or a hang after the button went down) left Button1 pressed after the worker exited, so later pointer motion continued the drag. Translated drags now have a time budget that follows the path (30 s base plus 20 ms per point and 2 ms per pixel of path length; a click adds its hold duration per click, a key chord its hold duration; hard cap 5 minutes). Measured with the original engine: about 9.6 ms per point on Apple Silicon containers (50 points 0.48 s, 500 points 4.85 s, 2,000 points 19.2 s) and about 4.4 ms per point (500 points 2.2 s) on the native x86-64 host. On a timeout, or an engine failure, after a translated call may have pressed something, LCU reads the X server's pressed buttons and keys (`XQueryPointer`, `XQueryKeymap`) and releases through XTEST only what is down now, was not down before the call, and is of a kind the call could press, before the worker stops. Check: with the release neutered, `tests/linux_input_drag.py` fails with "Button1 stayed pressed after the timeout".
2. P2: an active pointer grab by another client (a popup menu) received the click although the window chain at the point was the target. The helper now probes with `XGrabPointer` on the root (no event mask, undone at once) before a translated pointer action and refuses on `AlreadyGrabbed`, `GrabFrozen`, any other result or no answer. The probe is not free of effect: pointer events in its round trip (under a millisecond) go to nobody. `tests/gtk4_input.py` has an override-redirect popup that takes an active grab with the window manager running; every pointer action is refused and nothing reaches the popup or the target.
3. P2: equal numeric pids in distinct PID namespaces passed the proof. The helper now finds the X server through the display's local socket (`/proc/net/unix` inode, `/proc/*/fd` holders) and requires its `ns/pid` link to equal its own; TCP displays and unidentifiable servers fail closed; the X-Resource self-check remains as an additional condition. Regression: root with a writable `/proc/sys/kernel/ns_last_pid` starts a child PID namespace in which the helper's pid equals the pid the server sees; there the X-Resource check alone (mode `xres`, the 0.8.5 and 0.8.6 logic) trusts the server and the socket proof refuses. It is skipped with a notice unprivileged and was run privileged (see the release notes).

4. Found by the 26.928.31416 gate, which the 0.8.6 gate had skipped: after a timeout the original engine of 26.928.31416 survives the worker's exit (orphaned, PPid 1, no pending signal), so a resumed engine delivered the late key (`tests/linux_input_hang.py`: "a late key reached the entry", also with the 0.8.6 wrapper); 26.915.31945's transport kills it. LCU now ends the engine processes below the worker itself (SIGTERM then SIGCONT, waiting for them to be gone) before it releases input and stops the worker, and does not report the abandoned call's own outcome until then.

Remaining known limits are recorded in [ADAPTERS](../ADAPTERS.md#linux-window-targeted-input): the gap between the checks and the XTEST delivery, keyboard and passive grabs, XInput2-only grabs, and window managers other than Openbox and Xfwm4. `SYSTEM_PACKAGES` is unchanged (`libxtst6` was already listed).
