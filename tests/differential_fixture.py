"""Independent GTK state/file oracle for the differential desktop tests."""
import json
import os
from pathlib import Path
import sys
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

output = Path(os.environ['DIFFERENTIAL_OUTPUT'])
windows = []

if '--launched' in sys.argv:
    window = Gtk.Window(title='Differential Launched')
    window.add(Gtk.Label(label='Desktop entry launch completed'))
    window.show_all()
    (output / 'launched.txt').write_text('launched')
    Gtk.main()
    raise SystemExit

for name, x in [('Target', 10), ('Other', 670)]:
    window = Gtk.Window(title='Differential ' + name)
    window.set_default_size(600, 650)
    window.move(x, 20)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
    window.add(box)
    entry = Gtk.Entry()
    entry.get_accessible().set_name('Draft text')
    entry.set_text('untouched')
    live_value = output / (name + '-live.txt')
    live_value.write_text(entry.get_text())
    entry.connect('changed', lambda entry, path=live_value: path.write_text(entry.get_text()))
    box.pack_start(entry, False, False, 0)
    save = Gtk.Button(label='Save draft')
    def save_value(_, entry=entry, name=name):
        (output / (name + '.txt')).write_text(entry.get_text())
    save.connect('clicked', save_value)
    box.pack_start(save, False, False, 0)
    entry.connect('activate', lambda _, name=name: (output / (name + '-activated.txt')).write_text('yes'))
    popup = Gtk.Button(label='Open dialog')
    def open_dialog(_, window=window):
        dialog = Gtk.Dialog(title='Differential Dialog', transient_for=window, modal=True)
        dialog.add_button('Close dialog', Gtk.ResponseType.CLOSE)
        dialog.get_content_area().add(Gtk.Label(label='Dialog opened independently'))
        dialog.connect('response', lambda d, _: d.destroy())
        dialog.connect('destroy', lambda _: (output / 'dialog-closed.txt').write_text('closed'))
        dialog.show_all()
        (output / 'dialog-opened.txt').write_text('opened')
    popup.connect('clicked', open_dialog)
    box.pack_start(popup, False, False, 0)
    scrolled = Gtk.ScrolledWindow()
    scrolled.set_size_request(580, 220)
    box.pack_start(scrolled, True, True, 0)
    rows = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    scrolled.add(rows)
    for i in range(100):
        rows.pack_start(Gtk.Button(label=f'Row {i}'), False, False, 0)
    scrolled.get_vadjustment().connect('value-changed', lambda a, name=name:
        (output / (name + '-scroll.txt')).write_text(str(a.get_value())))
    area = Gtk.DrawingArea()
    area.set_size_request(580, 250)
    area.get_accessible().set_name('Pointer oracle')
    area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK)
    box.pack_start(area, False, False, 0)
    def pointer(_, event, name=name):
        with (output / (name + '-pointer.jsonl')).open('a') as stream:
            stream.write(json.dumps({'type': int(event.type), 'x': round(event.x),
                                     'y': round(event.y), 'state': int(event.state)}) + '\n')
        return False
    for event_name in ('button-press-event', 'button-release-event', 'motion-notify-event'):
        area.connect(event_name, pointer)
    window.show_all()
    windows.append(window)
    (output / (name + '.txt')).write_text('untouched')

clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
clipboard.set_text('differential-clipboard-seed', -1)
clipboard.store()
Gtk.main()
