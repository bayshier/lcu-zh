"""GTK 4 windows for window-targeted input tests: scroll offset, drag, a modal dialog and a mapped-library variant.

Every observation is written to LCU_TEST_OUTPUT, so the files, not call success, are the oracle.
`--chromium-like` maps a file named icudtl.dat first, as Chromium and Electron do; LCU must not treat
such a process as a GTK 4 application.
"""
from pathlib import Path
import mmap
import os
import sys
import tempfile
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import GLib, Gtk

output = Path(os.environ['LCU_TEST_OUTPUT'])
chromium_like = '--chromium-like' in sys.argv
if chromium_like:
    directory = tempfile.mkdtemp()
    data = Path(directory, 'icudtl.dat')
    data.write_bytes(b'\0' * 4096)
    handle = open(data, 'rb')
    mapped = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
prefix = 'Gtk4Chromium' if chromium_like else 'Gtk4Surface'

surface = Gtk.Window(title='LCU GTK4 Chromium-like' if chromium_like else 'LCU GTK4 Surface')
surface.set_default_size(420, 420)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
surface.set_child(box)

entry = Gtk.Entry()
entry.connect('changed', lambda widget: (output / f'{prefix}-entry.txt').write_text(widget.get_text()))
box.append(entry)

drag_area = Gtk.DrawingArea()
drag_area.set_content_width(300)
drag_area.set_content_height(80)
drag = Gtk.GestureDrag()
drag.connect('drag-end', lambda _gesture, dx, dy: (output / f'{prefix}-drag.txt').write_text(f'{dx:.0f},{dy:.0f}'))
drag_area.add_controller(drag)
box.append(drag_area)

scrolled = Gtk.ScrolledWindow()
scrolled.set_vexpand(True)
content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
for number in range(120):
    content.append(Gtk.Label(label=f'Row {number}'))
scrolled.set_child(content)
scrolled.get_vadjustment().connect('value-changed', lambda adjustment: (output / f'{prefix}-scroll.txt').write_text(f'{adjustment.get_value():.0f}'))
box.append(scrolled)

modal = None


def poll():
    global modal
    if (output / f'{prefix}-open-modal').exists() and modal is None:
        (output / f'{prefix}-open-modal').unlink()
        modal = Gtk.Window(title='LCU GTK4 Modal', modal=True, transient_for=surface)
        modal.set_default_size(300, 100)
        modal_entry = Gtk.Entry()
        modal_entry.connect('changed', lambda widget: (output / f'{prefix}-modal-entry.txt').write_text(widget.get_text()))
        modal.set_child(modal_entry)
        modal.present()
    elif (output / f'{prefix}-close-modal').exists() and modal is not None:
        (output / f'{prefix}-close-modal').unlink()
        modal.destroy()
        modal = None
    return True


GLib.timeout_add(100, poll)
surface.present()
GLib.MainLoop().run()
