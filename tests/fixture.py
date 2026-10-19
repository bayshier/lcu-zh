"""An independent GTK application whose saved files are the test oracle."""
from pathlib import Path
import os
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

windows = []
for name in ('Target', 'Other'):
    window = Gtk.Window(title='LCU ' + name)
    window.set_default_size(480, 180)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    box.set_border_width(20)
    window.add(box)
    entry = Gtk.Entry()
    entry.get_accessible().set_name('Draft text')
    entry.set_text('untouched' if name == 'Other' else '')
    button = Gtk.Button(label='Save draft')
    status = Gtk.Label(label='Not saved')
    for widget in (entry, button, status):
        box.pack_start(widget, False, False, 0)
    def save(_, entry=entry, status=status, name=name):
        Path(os.environ['LCU_TEST_OUTPUT'], name + '.txt').write_text(entry.get_text())
        status.set_text('Saved: ' + entry.get_text())
    button.connect('clicked', save)
    entry.connect('activate', lambda _, name=name: Path(os.environ['LCU_TEST_OUTPUT'], name + '-activated').write_text('yes'))
    window.show_all()
    windows.append(window)
Gtk.main()
