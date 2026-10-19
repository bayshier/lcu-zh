"""Shared helpers for the Linux window-targeted input tests: fixtures, window lookup and file oracles."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from mcp_client import Client, text

output = Path(os.environ['LCU_TEST_OUTPUT'])
here = Path(__file__).resolve().parent
fixtures = []


def settle(predicate, attempts=40, delay=0.1):
    for _ in range(attempts):
        if predicate():
            return True
        time.sleep(delay)
    return False


def read(name):
    path = output / name
    return path.read_text() if path.exists() else None


def start_fixture(script, *arguments, **environment):
    process = subprocess.Popen([sys.executable, str(here / script), *arguments],
                               env={**os.environ, **environment}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fixtures.append(process)
    return process


def stop_fixtures():
    for process in fixtures:
        process.terminate()
    for process in fixtures:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
    fixtures.clear()


_x11 = None


def _display():
    """A cached connection of the test process itself, to read the X server's input state."""
    global _x11
    if _x11 is None:
        x = ctypes.CDLL('libX11.so.6')
        x.XOpenDisplay.restype = ctypes.c_void_p
        x.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x.XDefaultRootWindow.restype = ctypes.c_ulong
        x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_void_p] * 7
        x.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_char * 32]
        display = x.XOpenDisplay(None)
        assert display, 'no X display'
        _x11 = (x, display, x.XDefaultRootWindow(display))
    return _x11


def buttons_down():
    """The pointer buttons (1-5) the X server reports pressed."""
    x, display, root = _display()
    mask = ctypes.c_uint()
    scratch = [ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int()]
    assert x.XQueryPointer(display, root, *[ctypes.byref(item) for item in scratch], ctypes.byref(mask))
    return [number for number in range(1, 6) if mask.value & (1 << (7 + number))]


def keys_down():
    """The key codes the X server reports pressed."""
    x, display, _root = _display()
    keymap = (ctypes.c_char * 32)()
    x.XQueryKeymap(display, keymap)
    return {byte * 8 + bit for byte in range(32) for bit in range(8) if keymap[byte][0] & (1 << bit)}


def descendants(root):
    parents = {}
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            try:
                stat = (entry / 'stat').read_text()
                parents[int(entry.name)] = int(stat[stat.rindex(')') + 2:].split()[1])
            except (OSError, ValueError, IndexError):
                pass
    found, frontier = set(), {root}
    while frontier:
        frontier = {pid for pid, parent in parents.items() if parent in frontier and pid not in found}
        found |= frontier
    return found


def engines(root):
    """The original engine processes (sky_linux_*) under a process."""
    result = []
    for pid in descendants(root):
        try:
            argv = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
        except OSError:
            continue
        if argv and os.path.basename(argv[0].decode(errors='replace')).startswith('sky_linux_'):
            result.append(pid)
    return result


def alive(pid):
    try:
        os.kill(pid, 0)
        state = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[0]
        return state != 'Z'
    except (OSError, IndexError):
        return False


class Session:
    """One stdio MCP client to the installed lcu with the sky service imported for direct calls."""

    def __init__(self, command, env=None):
        self.client = Client(command, env=env)
        self.run('await cua.getState();')
        self.run('globalThis.sky = (await import("@oai/sky")).sky;'
                 'globalThis.byTitle = async title => (await sky.list_windows()).find(w => w.title === title);')

    def run(self, code, error=False):
        return text(self.client.js(code, error=error))

    def windows(self):
        # The engine can fail a listing that races with a window closing (X BadWindow); retry once settled.
        for attempt in range(10):
            result = self.client.call('tools/call', {'name': 'js', 'arguments': {
                'code': 'nodeRepl.write(JSON.stringify(await sky.list_windows()));'}})
            if not result.get('isError'):
                return json.loads(text(result))
            time.sleep(0.2)
        raise AssertionError(text(result))

    def window(self, title, attempts=60):
        for _ in range(attempts):
            found = next((w for w in self.windows() if w.get('title') == title), None)
            if found:
                return found
            time.sleep(0.2)
        raise AssertionError(f'window not found: {title}: {self.windows()}')

    def focused_id(self):
        focused = [w['id'] for w in self.windows() if w.get('focused')]
        return focused[0] if focused else None

    def activate(self, title):
        self.run(f'await sky.activate_window({{window: await byTitle({json.dumps(title)})}});')
        window = self.window(title)
        assert settle(lambda: self.focused_id() == window['id']), (title, self.windows())
        return window

    def close(self):
        self.client.close()
