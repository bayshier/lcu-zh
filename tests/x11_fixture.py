"""An Xlib window without accessibility, recording received pointer events."""
import ctypes as c
import os
from pathlib import Path

x = c.CDLL('libX11.so.6')
def function(name, args, result):
    method = getattr(x, name)
    method.argtypes, method.restype = args, result
    return method
pointer, ulong, integer = c.c_void_p, c.c_ulong, c.c_int
display = function('XOpenDisplay', [c.c_char_p], pointer)(None)
assert display
screen = function('XDefaultScreen', [pointer], integer)(display)
root = function('XRootWindow', [pointer, integer], ulong)(display, screen)
window = function('XCreateSimpleWindow', [pointer, ulong, integer, integer, c.c_uint, c.c_uint, c.c_uint, ulong, ulong], ulong)(display, root, 600, 400, 240, 160, 1, 0, 0xeeeeee)
function('XStoreName', [pointer, ulong, c.c_char_p], integer)(display, window, b'LCU Fallback')
atom = function('XInternAtom', [pointer, c.c_char_p, integer], ulong)
pid = ulong(os.getpid())
function('XChangeProperty', [pointer, ulong, ulong, ulong, integer, integer, pointer, integer], integer)(display, window, atom(display, b'_NET_WM_PID', 0), atom(display, b'CARDINAL', 0), 32, 0, c.byref(pid), 1)
function('XSelectInput', [pointer, ulong, c.c_long], integer)(display, window, 1 << 2)
function('XMapWindow', [pointer, ulong], integer)(display, window)
function('XFlush', [pointer], integer)(display)
class Button(c.Structure):
    _fields_ = [('type', integer), ('serial', ulong), ('send_event', integer), ('display', pointer),
                ('window', ulong), ('root', ulong), ('subwindow', ulong), ('time', ulong),
                ('x', integer), ('y', integer), ('x_root', integer), ('y_root', integer),
                ('state', c.c_uint), ('button', c.c_uint), ('same_screen', integer)]
class Event(c.Union):
    _fields_ = [('button', Button), ('pad', c.c_long * 24)]
event = Event()
next_event = function('XNextEvent', [pointer, c.POINTER(Event)], integer)
while True:
    next_event(display, c.byref(event))
    if event.button.type == 4:
        Path(os.environ['LCU_TEST_OUTPUT'], 'fallback-click.txt').write_text(f'{event.button.x},{event.button.y}')
