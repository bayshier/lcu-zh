# OpenAI issue: Linux computer use ignores window-targeted input in GTK 4 apps

Filed 2026-10-03 as https://github.com/openai/codex/issues/50578.

---

**Title:** Linux computer use: window-targeted keys, clicks, scroll and drag do nothing in GTK 4 apps

**Body:**

On Linux (X11), window-targeted input from computer use is silently ignored by GTK 4 apps. The calls succeed, but the app never receives the input.

ChatGPT for Linux 26.928.31416 (CUA runtime 0.0.27/20260927214556-b77d38801cca), Ubuntu 24.04, Xvfb with XTEST, Xfwm4.

### Cause

When an action targets a window (`app.pressKey`, `app.click`, `app.scroll`, `app.drag` with a window), the Linux engine delivers core X events with `XSendEvent` to that window (they arrive with `send_event=1`). GTK 4 reads input only through XInput2, so it never sees them. Qt ignores window-targeted scroll the same way. GTK 3, Firefox, Chromium, Electron and terminals accept the events.

Desktop-level actions (no window, after activating it) go through XTEST and work in every app.

### Reproduction

1. Start an X11 session (Xvfb + Xfwm4) with ChatGPT for Linux 26.928.31416 and computer use available to an agent.
2. Run `gnome-text-editor --standalone` and type some text in it.
3. Through computer use, send `ctrl+a` then `BackSpace` to the editor window with `app.pressKey`, or click inside it with `app.click`.

Result: the calls return success; the text is unchanged and no click is received.

Expected: the editor receives the keys and the click, as it does when the same actions are sent desktop-level after `activate_window`.

For comparison, `xdotool key ctrl+a` (XTEST) works in the same editor.

### Suggested fix

For window-targeted input on X11, inject through XTEST (activating the window first), or deliver through XInput2, instead of `XSendEvent`. At minimum, report an error when the input cannot reach the target rather than returning success.
