"""Run a bounded Hermes model turn against an isolated generated GTK fixture.

This is an opt-in integration runner, not part of the offline unit suite. It
uses a fresh HOME/HERMES_HOME, the installed Hermes CLI selected by the caller,
an already-running isolated Linux CUA fixture reached through docker exec, and
an OpenAI-compatible model proxy with a synthetic API key.

Required environment:
  HERMES_BIN             Hermes CLI installed from the official stable tag
  HERMES_TEST_NODE       Node executable used by the packaged MCP bridge
  LCU_TEST_RELEASE       unpacked LCU release tree for the target platform
  LCU_TEST_CONTAINER     disposable GTK fixture container name
  LCU_TEST_MODEL         model id supported by the local test proxy
  LCU_TEST_BASE_URL      OpenAI-compatible /v1 endpoint served by the proxy
  LCU_TEST_API_KEY       synthetic proxy key (never written to disk)

Optional:
  LCU_TEST_BINARY        in-container LCU executable (default /tmp/lcu-runtime)
  LCU_TEST_DOCKER_BIN    host Docker client executable (default PATH lookup)
  LCU_TEST_DOCKER_PREFIX JSON array of docker prefix args, e.g. ["--host",
                         "unix:///path/to/docker.sock"]
  LCU_TEST_OUTPUT_DIR    fixture oracle directory (default
                         /tmp/lcu-desktop-output)
  LCU_TEST_MARKER         generated marker (default is randomized)
  LCU_TEST_TIMEOUT        Hermes subprocess timeout, seconds (default 300)
  LCU_TEST_EVIDENCE       optional JSON evidence destination (outside repo)
  LCU_TEST_TOOL_SEARCH    native Hermes progressive tool disclosure: off (default)
                         keeps js/js_reset direct; on exercises search/call wrapper.

The runner records no host credential files. Hermes sees only the synthetic
OPENAI_API_KEY in the one-shot subprocess environment.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
TEMP_PARENT = "/private/tmp" if sys.platform == "darwin" else "/tmp"
from lcu_node import call  # noqa: E402


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def run(argv: list[str], *, cwd: Path, env: dict[str, str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)


def main() -> None:
    hermes = Path(required("HERMES_BIN")).resolve()
    node = Path(required("HERMES_TEST_NODE")).resolve()
    release = Path(required("LCU_TEST_RELEASE")).resolve()
    container = required("LCU_TEST_CONTAINER")
    model = required("LCU_TEST_MODEL")
    base_url = required("LCU_TEST_BASE_URL").rstrip("/")
    synthetic_key = required("LCU_TEST_API_KEY")
    marker = os.environ.get("LCU_TEST_MARKER", "hermes-lcu-" + secrets.token_hex(6))
    lcu_binary = os.environ.get("LCU_TEST_BINARY", "/tmp/lcu-runtime")
    docker_prefix = json.loads(os.environ.get("LCU_TEST_DOCKER_PREFIX", "[]"))
    output_dir = os.environ.get("LCU_TEST_OUTPUT_DIR", "/tmp/lcu-desktop-output")
    timeout = int(os.environ.get("LCU_TEST_TIMEOUT", "300"))
    tool_search = os.environ.get("LCU_TEST_TOOL_SEARCH", "off").lower()
    if tool_search not in {"off", "on"}:
        raise SystemExit("LCU_TEST_TOOL_SEARCH must be 'off' or 'on'")

    if not hermes.is_file() or not node.is_file():
        raise SystemExit("HERMES_BIN and HERMES_TEST_NODE must name executable files")
    if not (release / "adapters/hermes/bridge.mjs").is_file():
        raise SystemExit(f"LCU release has no Hermes bridge: {release}")
    if not base_url.startswith("http://127.0.0.1:"):
        raise SystemExit("The model proxy must be loopback-only (http://127.0.0.1:<port>/v1)")

    # Hermes runs on the host while LCU and GTK remain inside an isolated
    # network-none container. Node starts the original LCU MCP client, whose
    # command is only a docker exec into that fixture.
    docker = os.environ.get("LCU_TEST_DOCKER_BIN") or shutil.which("docker")
    if not docker:
        raise SystemExit("docker is required to reach the isolated GTK fixture")
    docker_base = [docker, *docker_prefix]
    command = [*docker_base, "exec", "-i", "-u", "lcutester", container, lcu_binary]

    with tempfile.TemporaryDirectory(prefix="lcu-hermes-e2e-", dir=TEMP_PARENT) as temp:
        root = Path(temp)
        home = root / "home"
        hermes_home = root / "hermes"
        home.mkdir()
        hermes_home.mkdir()
        # Hermes' documented custom endpoint config uses OPENAI_API_KEY as the
        # custom route fallback. The synthetic key is process-only, not saved.
        env = {
            "PATH": os.pathsep.join([str(hermes.parent), str(node.parent), "/usr/bin", "/bin"]),
            "HOME": str(home),
            "HERMES_HOME": str(hermes_home),
            "OPENAI_API_KEY": synthetic_key,
        }

        call("harness_setup", "configureHermes", home, command, node, release, {"scope": "user", "env": env})

        # Use Hermes' own config command so plugin enablement and unrelated
        # native settings are preserved. The endpoint contains no credential.
        for key, value in (
            ("model.provider", "custom"),
            ("model.default", model),
            ("model.base_url", base_url),
            ("model.api_mode", "chat_completions"),
            ("agent.max_turns", "12"),
            # Default off proves direct schemas; on exercises Hermes' native
            # progressive-disclosure bridge while preserving the same allowlist.
            ("tools.tool_search.enabled", tool_search),
        ):
            result = run([str(hermes), "config", "set", key, value], cwd=home,
                         env={**env, "HERMES_HOME": str(hermes_home)})
            if result.returncode:
                raise SystemExit(f"Hermes config set {key} failed:\n{result.stderr}{result.stdout}")

        # The prompt deliberately constrains the task to generated UI state;
        # no shell/file tools are authorized by the user request.
        prompt = (
            "Use LCU's js tool only. Find the GTK "
            "window titled 'LCU Target'. Enter the exact marker " + marker +
            " into its Draft text field, click Save draft, then verify on screen "
            "that it says 'Saved: " + marker + "'. Do not interact with any other "
            "window. Do not use shell, terminal, filesystem, browser, or other "
            "tools. Report the exact saved marker."
        )
        invocation = [str(hermes), "chat", "--oneshot", "--provider", "custom",
                      "--model", model, "--toolsets", "lcu_cua", "--max-turns", "12",
                      "--format", "stream-json", "-q", prompt]
        result = run(invocation, cwd=home,
                     env={**env, "HERMES_HOME": str(hermes_home)}, timeout=timeout)
        output = result.stdout + result.stderr
        events = []
        for line in result.stdout.splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        tool_names = [event.get("name") for event in events if event.get("type") == "tool_use"]
        tool_events = [event for event in events if event.get("type") == "tool_use"]
        invoked = [name for name in tool_names if name in ("js", "js_reset")]
        escaped = []
        for event in tool_events:
            if event.get("name") == "tool_call":
                inputs = event.get("input") or {}
                calls = inputs.get("calls", []) if isinstance(inputs, dict) else []
                names = [item.get("name") for item in calls if isinstance(item, dict)]
                if len(names) != len(calls) or any(name not in ("js", "js_reset") for name in names):
                    escaped.extend(names)
                invoked.extend(names)

        # Independent fixture oracle; read it from inside the disposable
        # container rather than trusting Hermes' report or the MCP response.
        check = run([*docker_base, "exec", "-u", "lcutester", container, "cat",
                     output_dir + "/Target.txt"],
                    cwd=home, env=env)
        other = run([*docker_base, "exec", "-u", "lcutester", container, "test", "!", "-e",
                     output_dir + "/Other.txt"], cwd=home, env=env)
        version = run([str(hermes), "--version"], cwd=home, env=env).stdout.strip()
        evidence = {
            "result": "pending",
            "hermes_version": version,
            "model": model,
            "tool_search": tool_search,
            "session_id": next((event.get("session_id") for event in events
                                if event.get("type") == "system"), None),
            "tools": tool_names,
            "marker": marker,
            "hermes_exit_code": result.returncode,
            "hermes_stdout": result.stdout,
            "hermes_stderr": result.stderr,
            "tool_events": tool_events,
            "invoked_lcu_tools": invoked,
            "escaped_tool_call_names": escaped,
            "target_exit_code": check.returncode,
            "target_text": check.stdout,
            "target_stderr": check.stderr,
            "other_exists": other.returncode != 0,
        }
        evidence_path = os.environ.get("LCU_TEST_EVIDENCE")
        if evidence_path:
            Path(evidence_path).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

        if result.returncode:
            raise SystemExit(f"Hermes one-shot failed ({result.returncode}); evidence saved: {evidence_path or '(not requested)'}\n{output}")
        if "js" not in invoked:
            raise SystemExit(f"No original LCU js tool was called; observed: {tool_names}\n{output}")
        if any(name not in ("js", "js_reset", "tool_search", "tool_describe", "tool_call")
               for name in tool_names):
            raise SystemExit(f"Unexpected model-visible tool call(s): {tool_names}")
        if escaped:
            raise SystemExit(f"Hermes tool_call escaped the LCU toolset: {escaped}")
        if check.returncode or check.stdout != marker:
            raise SystemExit(f"Independent Target.txt oracle mismatch: {check.stdout!r}\n{check.stderr}")
        if other.returncode:
            raise SystemExit("Isolation oracle failed: LCU Other window was changed")
        evidence["result"] = "passed"
        evidence["oracle"] = "Target.txt exact marker; Other.txt absent"
        if evidence_path:
            Path(evidence_path).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
