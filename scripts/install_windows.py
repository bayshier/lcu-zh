"""Compatibility stub: LCU 0.9.7's `lcu update` runs this file with its own Python. It holds no logic and
hands over, with the same arguments, to the Node installer through scripts/install.ps1."""
import os
import subprocess
import sys

script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'install.ps1')
sys.exit(subprocess.call(['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                          '-File', script, *sys.argv[1:]]))
