"""A Qt 5 window whose scroll offset, entry text and button clicks are written to LCU_TEST_OUTPUT."""
from pathlib import Path
import os
import sys
from PyQt5.QtWidgets import QApplication, QLabel, QLineEdit, QPushButton, QScrollArea, QVBoxLayout, QWidget

output = Path(os.environ['LCU_TEST_OUTPUT'])
application = QApplication(sys.argv)
window = QWidget()
window.setWindowTitle('LCU Qt Surface')
window.resize(420, 420)
layout = QVBoxLayout(window)
entry = QLineEdit()
entry.textChanged.connect(lambda text: (output / 'Qt-entry.txt').write_text(text))
button = QPushButton('Press')
button.clicked.connect(lambda: (output / 'Qt-click').write_text('yes'))
scroll = QScrollArea()
label = QLabel('\n'.join(f'Row {number}' for number in range(150)))
scroll.setWidget(label)
scroll.verticalScrollBar().valueChanged.connect(lambda value: (output / 'Qt-scroll.txt').write_text(str(value)))
for widget in (entry, button, scroll):
    layout.addWidget(widget)
window.show()
sys.exit(application.exec_())
