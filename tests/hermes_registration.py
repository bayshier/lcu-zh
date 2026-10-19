"""Verify the generated Hermes plugin through the installed Hermes plugin loader."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys

from lcu_node import call

ROOT = Path(__file__).resolve().parents[1]
TEMP_PARENT = "/private/tmp" if sys.platform == "darwin" else "/tmp" if os.name == "posix" else None


def main() -> None:
    hermes = os.environ.get("HERMES_BIN") or shutil.which("hermes")
    if not hermes:
        raise SystemExit("Set HERMES_BIN or add an installed Hermes CLI to PATH.")
    node = Path(shutil.which("node") or "").resolve()
    if not node.is_file():
        raise SystemExit("Node is required for the original LCU MCP SDK bridge.")

    with tempfile.TemporaryDirectory(prefix="lcu-hermes-registration-", dir=TEMP_PARENT) as temporary:
        root = Path(temporary)
        home = root / "home"
        hermes_home = root / "hermes"
        for directory in (home, hermes_home):
            directory.mkdir(parents=True, exist_ok=True)
        env = {
            "PATH": os.pathsep.join([str(Path(hermes).resolve().parent), str(node.parent), "/usr/bin", "/bin"]),
            "HOME": str(home),
            "HERMES_HOME": str(hermes_home),
        }
        call("harness_setup", "configureHermes", home, [str(node), str(ROOT / "adapters/test/mcp-fixture.mjs")],
             node, ROOT, {"scope": "user", "env": env})
        command = [hermes, "plugins", "doctor", "lcu-cua", "--ci"]
        result = subprocess.run(command, cwd=home, env=env, text=True, capture_output=True, timeout=90)
        output = result.stdout + result.stderr
        if result.returncode != 0:
            raise SystemExit(f"Hermes plugin doctor failed ({result.returncode}):\n{output}")
        expected = "registrations: 2 tool(s), 2 hook(s)"
        if expected not in output or "registration passed" not in output:
            raise SystemExit(f"Hermes plugin doctor did not confirm expected registrations:\n{output}")
        print(f"Hermes native plugin loader passed: {expected}")
        print(f"Isolated HERMES_HOME: {hermes_home}")


if __name__ == "__main__":
    main()
