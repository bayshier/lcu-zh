"""Compatibility stub: LCU 0.9.7's `lcu update` runs this file with its own Python. It holds no logic and
hands over, with the same arguments, to the Node installer through scripts/install.sh."""
import os
import sys

script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'install.sh')
os.execv('/bin/sh', ['/bin/sh', script, *sys.argv[1:]])
