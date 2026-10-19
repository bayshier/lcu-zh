"""Independent GTK 4 windows whose saved files are the oracle for input delivery."""
from pathlib import Path
import os
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import GLib, Gtk

output = Path(os.environ['LCU_TEST_OUTPUT'])

entry_window = Gtk.Window(title='LCU GTK4 Entry')
entry_window.set_default_size(420, 120)
entry = Gtk.Entry()
entry.set_margin_top(20)
entry.set_margin_bottom(20)
entry.set_margin_start(20)
entry.set_margin_end(20)
entry.connect('changed', lambda widget: (output / 'Gtk4-entry.txt').write_text(widget.get_text()))
entry.connect('activate', lambda _: (output / 'Gtk4-activated').write_text('yes'))
entry_window.set_child(entry)

button_window = Gtk.Window(title='LCU GTK4 Button')
button_window.set_default_size(300, 160)
button = Gtk.Button(label='Press')
button.connect('clicked', lambda _: (output / 'Gtk4-click').write_text('yes'))
button_window.set_child(button)

for window in (button_window, entry_window):
    window.present()
GLib.MainLoop().run()
