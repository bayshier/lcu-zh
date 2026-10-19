"""LCU's X questions against a real X server: process identity is trusted only from a server in LCU's PID namespace.

SO_PEERCRED process ids, which the X server reports through X-Resource, are relative to the PID namespace of
the server, and equal numbers in two PID namespaces prove nothing. LCU
(lcu/x11.mjs, asked by lcu/linux_sky_service.mjs) therefore proves, before it trusts any id, that the X server
shares its PID namespace from the actual socket: it resolves the display's socket (/tmp/.X11-unix/X<n>, abstract or
file), finds the listening process through /proc/net/unix and /proc/*/fd, and requires that process's
/proc/<pid>/ns/pid to equal its own. A TCP or remote display, an unidentifiable server or one in another
namespace fails closed. The own client id check (the server's record of LCU's own client equals getpid())
stays as an additional condition.

This test asks through tests/x11_helper.mjs, which prints what the former python3 helper printed:
 1. from this namespace: it must report the process owning a window, and the socket proof must hold; a TCP-style
    DISPLAY must not pass the proof;
 2. from a child PID namespace against the same server (`unshare`, where permitted): it must report nothing;
 3. privileged only (root with a writable /proc/sys/kernel/ns_last_pid): from a child PID namespace whose pid for
    the helper is *equal* to the pid the server sees for it. There the X-Resource self-check alone passes (the
    `xres` mode, which is what LCU 0.8.5 and 0.8.6 trusted) and the socket proof must be what refuses.
Parts 2 and 3 are skipped with a notice where the environment does not allow them. `guard` must answer in every
case, so a refusal cannot come from an unreachable X server.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

repo = Path(__file__).resolve().parent.parent
node = shutil.which('node')
driver = str(repo / 'tests/x11_helper.mjs')


def helper(*arguments, prefix=(), env=None):
    result = subprocess.run([*prefix, node, driver, *arguments], capture_output=True, text=True, timeout=30,
                            env={**os.environ, **(env or {})})
    return result.stdout.strip()


# A window of this very process: the server must attribute it to os.getpid().
import ctypes as c
x11 = c.CDLL('libX11.so.6')
x11.XOpenDisplay.restype = c.c_void_p
x11.XOpenDisplay.argtypes = [c.c_char_p]
x11.XDefaultRootWindow.restype = c.c_ulong
x11.XDefaultRootWindow.argtypes = [c.c_void_p]
x11.XCreateSimpleWindow.restype = c.c_ulong
x11.XCreateSimpleWindow.argtypes = [c.c_void_p, c.c_ulong, c.c_int, c.c_int, c.c_uint, c.c_uint, c.c_uint, c.c_ulong, c.c_ulong]
x11.XFlush.argtypes = [c.c_void_p]
display = x11.XOpenDisplay(None)
assert display, 'no X display'
window_id = str(x11.XCreateSimpleWindow(display, x11.XDefaultRootWindow(display), 0, 0, 20, 20, 0, 0, 0))
x11.XFlush(display)
expected = str(os.getpid())
number = os.environ['DISPLAY'].split(':')[-1].split('.')[0]

assert helper('socket') == '1', ('the X server in this namespace was not recognized', helper('socket'))
assert helper('pid', window_id) == expected, ('same namespace', helper('pid', window_id), expected)
assert helper('xres', window_id) == expected
for display_name in (f'unix:{number}', f':{number}.0'):
    assert helper('socket', env={'DISPLAY': display_name}) == '1', display_name
for display_name in (f'localhost:{number}', f'127.0.0.1:{number}.0', f'someone:{number}', '', 'unix', ':', ':x'):
    assert helper('socket', env={'DISPLAY': display_name}) == '0', ('a non-local display passed the proof', display_name)
    assert helper('pid', window_id, env={'DISPLAY': display_name}) == '', display_name
guard = json.loads(helper('guard', window_id, '0', '0'))
assert guard['grab'] == 0 and guard['owner'] in (True, False), guard
assert isinstance(guard['buttons'], list) and isinstance(guard['keys'], list) and guard['modifiers'], guard


def child(*prefix):
    inside = subprocess.run([*prefix, 'sh', '-c', 'echo $$'], capture_output=True, text=True)
    if inside.returncode != 0 or inside.stdout.strip() != '1':
        return None
    return {'identity': helper('pid', window_id, prefix=prefix), 'socket': helper('socket', prefix=prefix),
            'guard': helper('guard', window_id, '0', '0', prefix=prefix)}

result = None
for prefix in (('unshare', '--pid', '--fork', '--mount-proc'),
               ('unshare', '--user', '--map-root-user', '--pid', '--fork', '--mount-proc')):
    result = child(*prefix)
    if result is not None:
        break
if result is None:
    print('INFO: no PID namespace available here; the cross-namespace refusal was not exercised', flush=True)
else:
    assert json.loads(result['guard'])['owner'] in (True, False), ('the X server was not reachable from the child namespace', result)
    assert result['identity'] == '', ('a server in another PID namespace was trusted', result)
    assert result['socket'] == '0', ('the X server was found from a child PID namespace', result)

# Aligned ids: the helper's pid in a child PID namespace equals its pid in this one, so everything the server
# reports (SO_PEERCRED ids are in the server's namespace) matches by number. Needs root to set ns_last_pid.
LAUNCHER = r'''
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
wanted, node, driver, window = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
CLONE_NEWNS, CLONE_NEWPID, MS_REC, MS_PRIVATE = 0x20000, 0x20000000, 0x4000, 1 << 18
open('/proc/sys/kernel/ns_last_pid', 'w').write(str(wanted - 2))  # the next process of this namespace gets wanted - 1
if libc.unshare(CLONE_NEWPID) != 0:
    sys.exit(2)
init = os.fork()  # pid wanted - 1 here, 1 in the new namespace
if init:
    sys.exit(os.waitstatus_to_exitcode(os.waitpid(init, 0)[1]))
if libc.unshare(CLONE_NEWNS) != 0 or libc.mount(None, b'/', None, MS_REC | MS_PRIVATE, None) != 0 \
        or libc.mount(b'proc', b'/proc', b'proc', 0, None) != 0:
    os._exit(2)
open('/proc/sys/kernel/ns_last_pid', 'w').write(str(wanted - 1))  # inside: the next process is numbered `wanted`
child = os.fork()  # `wanted` in both namespaces, unless another process of this container forked in between
if child:
    os._exit(os.waitstatus_to_exitcode(os.waitpid(child, 0)[1]))
os.execv(node, [node, driver, 'all', window])  # the same pid answers socket, xres and pid as one JSON line
'''


def aligned():
    if os.geteuid() != 0 or not os.access('/proc/sys/kernel/ns_last_pid', os.W_OK):
        return 'not root, or /proc/sys/kernel/ns_last_pid is not writable'
    for attempt in range(8):
        wanted = 4000 + 137 * attempt + os.getpid() % 100
        run = subprocess.run([sys.executable, '-c', LAUNCHER, str(wanted), node, driver, window_id],
                             capture_output=True, text=True, timeout=60)
        lines = [line for line in run.stdout.splitlines() if line.startswith('{')]
        if run.returncode != 0 or not lines:
            return f'a child PID namespace could not be created ({run.returncode}: {run.stderr.strip()[-200:]})'
        answers = json.loads(lines[-1])
        if answers['xres'] != expected:
            continue  # not aligned this time (a process forked in between): the X-Resource self-check failed
        assert answers['getpid'] == str(wanted), answers
        return answers
    return 'the pids could not be aligned'


outcome = aligned()
if isinstance(outcome, str):
    print(f'INFO: the aligned-pid regression was not exercised: {outcome}', flush=True)
else:
    # The old proof (the server's record of the helper's client equals getpid()) passes here by coincidence of numbers...
    assert outcome['xres'] == expected, outcome
    # ...and only the socket proof refuses: the X server cannot be found in this child namespace.
    assert outcome['socket'] == '0', ('the socket proof held across PID namespaces', outcome)
    assert outcome['pid'] == '', ('equal pids across PID namespaces were trusted', outcome)
    print('INFO: aligned pids across PID namespaces: X-Resource alone trusted them, the socket proof refused', flush=True)
print('PASS: LCU trusts the X server in this namespace and fails closed from a child PID namespace', flush=True)
