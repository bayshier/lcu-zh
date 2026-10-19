"""An override-redirect X11 window, as a notification, tooltip or popup menu is: no window manager involvement,
no keyboard focus, stacked above everything when mapped. It is shown and hidden by files in LCU_TEST_OUTPUT
and records every pointer button press it receives, so the file is the oracle for what an input call hit.

    overlay-show   "X,Y,WIDTH,HEIGHT" in desktop coordinates; the window is mapped there on top
    overlay-hide   unmaps it
    overlay-state  "shown" or "hidden", written after each change
    overlay-grab   takes an active pointer grab with the window (as a popup menu does: owner events, button
                   presses and releases selected); the window must be shown. overlay-ungrab drops it.
    overlay-grab-state  "held", "released" or "failed:N" (the X status), written after each change
    overlay-click.txt   one "x,y" line per button press that reached it
"""
import ctypes as c
import os
import time
from pathlib import Path

output = Path(os.environ['LCU_TEST_OUTPUT'])
x = c.CDLL('libX11.so.6')
pointer, ulong, integer = c.c_void_p, c.c_ulong, c.c_int


def function(name, args, result=integer):
    method = getattr(x, name)
    method.argtypes, method.restype = args, result
    return method


class Attributes(c.Structure):
    _fields_ = [('background_pixmap', ulong), ('background_pixel', ulong), ('border_pixmap', ulong),
                ('border_pixel', ulong), ('bit_gravity', integer), ('win_gravity', integer),
                ('backing_store', integer), ('backing_planes', ulong), ('backing_pixel', ulong),
                ('save_under', integer), ('event_mask', c.c_long), ('do_not_propagate_mask', c.c_long),
                ('override_redirect', integer), ('colormap', ulong), ('cursor', ulong)]


class Button(c.Structure):
    _fields_ = [('type', integer), ('serial', ulong), ('send_event', integer), ('display', pointer),
                ('window', ulong), ('root', ulong), ('subwindow', ulong), ('time', ulong),
                ('x', integer), ('y', integer), ('x_root', integer), ('y_root', integer),
                ('state', c.c_uint), ('button', c.c_uint), ('same_screen', integer)]


class Event(c.Union):
    _fields_ = [('button', Button), ('pad', c.c_long * 24)]


display = function('XOpenDisplay', [c.c_char_p], pointer)(None)
assert display
root = function('XDefaultRootWindow', [pointer], ulong)(display)
window = function('XCreateSimpleWindow', [pointer, ulong, integer, integer, c.c_uint, c.c_uint, c.c_uint, ulong, ulong],
                  ulong)(display, root, 0, 0, 10, 10, 0, 0, 0xff8800)
attributes = Attributes(override_redirect=1, event_mask=1 << 2)  # ButtonPressMask
function('XChangeWindowAttributes', [pointer, ulong, c.c_ulong, c.POINTER(Attributes)])(
    display, window, (1 << 9) | (1 << 11), c.byref(attributes))  # CWOverrideRedirect | CWEventMask
move_resize = function('XMoveResizeWindow', [pointer, ulong, integer, integer, c.c_uint, c.c_uint])
map_window = function('XMapRaised', [pointer, ulong])
unmap_window = function('XUnmapWindow', [pointer, ulong])
flush = function('XFlush', [pointer])
grab_pointer = function('XGrabPointer', [pointer, ulong, integer, c.c_uint, integer, integer, ulong, ulong, ulong])
ungrab_pointer = function('XUngrabPointer', [pointer, ulong])
pending = function('XPending', [pointer])
next_event = function('XNextEvent', [pointer, c.POINTER(Event)])
event = Event()
(output / 'overlay-state').write_text('hidden')
while True:
    show, hide = output / 'overlay-show', output / 'overlay-hide'
    if show.exists():
        left, top, width, height = map(int, show.read_text().split(','))
        show.unlink()
        move_resize(display, window, left, top, width, height)
        map_window(display, window)
        flush(display)
        (output / 'overlay-state').write_text('shown')
    if hide.exists():
        hide.unlink()
        unmap_window(display, window)
        flush(display)
        (output / 'overlay-state').write_text('hidden')
    grab, drop = output / 'overlay-grab', output / 'overlay-ungrab'
    if grab.exists():
        grab.unlink()
        status = grab_pointer(display, window, 1, (1 << 2) | (1 << 3), 1, 1, 0, 0, 0)  # async modes, CurrentTime
        flush(display)
        (output / 'overlay-grab-state').write_text('held' if status == 0 else f'failed:{status}')
    if drop.exists():
        drop.unlink()
        ungrab_pointer(display, 0)
        flush(display)
        (output / 'overlay-grab-state').write_text('released')
    while pending(display):
        next_event(display, c.byref(event))
        if event.button.type == 4:
            with open(output / 'overlay-click.txt', 'a') as handle:
                handle.write(f'{event.button.x},{event.button.y}\n')
    time.sleep(0.05)
