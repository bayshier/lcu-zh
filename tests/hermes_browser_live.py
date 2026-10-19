"""Run Hermes' real interactive CLI through the original LCU Chrome provider.

This opt-in acceptance runner uses a fresh Hermes profile, a loopback-only
model proxy, and the disposable official-Chrome fixture started by
harness_browser_session.sh. It accepts only the browser-origin once choice.
Evidence may contain original runtime instructions and must stay outside Git.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
from lcu_node import call  # noqa: E402

ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
ORIGIN = "http://127.0.0.1:8080"


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    for flag, env_name in (("hermes", "HERMES_BIN"), ("container", "HERMES_FIXTURE_CONTAINER"),
                           ("model", "HERMES_MODEL"), ("base-url", "HERMES_BASE_URL"),
                           ("api-key", "HERMES_API_KEY")):
        p.add_argument("--" + flag, default=os.environ.get(env_name), required=not bool(os.environ.get(env_name)))
    p.add_argument("--node", default=os.environ.get("HERMES_TEST_NODE") or shutil.which("node"))
    p.add_argument("--release", default=os.environ.get("LCU_TEST_RELEASE", str(ROOT)),
                   help="unpacked LCU release tree containing adapters/hermes")
    p.add_argument("--docker-host", default=os.environ.get("LCU_DOCKER_HOST"))
    p.add_argument("--runtime", default="/home/browser-test/lcu-current/current/bin/lcu")
    p.add_argument("--evidence-file", default=os.environ.get("HERMES_BROWSER_EVIDENCE"))
    p.add_argument("--timeout", type=int, default=300)
    return p.parse_args()


def validate_proxy(raw):
    value = urlsplit(raw)
    try:
        loopback = value.hostname == "localhost" or ipaddress.ip_address(value.hostname or "").is_loopback
    except ValueError:
        loopback = False
    if value.scheme not in ("http", "https") or not loopback or value.username or value.password or value.fragment:
        raise SystemExit("Hermes model proxy must be an HTTP(S) loopback URL without embedded credentials")
    return value


def run(argv, env, cwd, timeout=40):
    return subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)


def instrument_cleanup(plugin_file: Path, log_file: Path) -> None:
    """Add a write-only observer after the real plugin cleanup succeeds.

    This modifies only the generated plugin copy in a disposable HERMES_HOME;
    the actual `turnEnded` call and its result handling remain unchanged.
    """
    source = plugin_file.read_text(encoding="utf-8")
    anchor = "            with turn_lock:\n                pending_cleanups.pop((session_id, exact_turn), None)"
    observer = (
        "            lifecycle_path = os.environ.get('LCU_HERMES_LIFECYCLE_LOG')\n"
        "            if lifecycle_path:\n"
        "                with open(lifecycle_path, 'a', encoding='utf-8') as lifecycle_file:\n"
        "                    lifecycle_file.write(json.dumps({'session_id': session_id, 'turn_id': exact_turn, 'event': pending_event or event}) + '\\n')\n"
    )
    if source.count(anchor) != 1:
        raise RuntimeError("Hermes generated adapter cleanup anchor changed; refusing to instrument")
    plugin_file.write_text(source.replace(anchor, observer + anchor), encoding="utf-8")


def adapter_digest(release: Path) -> str:
    digest = hashlib.sha256()
    for name in ("plugin.yaml", "__init__.py", "bridge.mjs"):
        path = release / "adapters/hermes" / name
        digest.update(name.encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def browser_page_urls(docker_base, container, env, cwd):
    script = (
        'from pathlib import Path; import json,urllib.request; '
        'port=(Path.home()/".config/lcu-chrome-direct-fixture/DevToolsActivePort").read_text().splitlines()[0]; '
        'tabs=json.load(urllib.request.urlopen("http://127.0.0.1:"+port+"/json/list")); '
        'print(json.dumps([x["url"] for x in tabs if x.get("type")=="page"]))'
    )
    result = run([*docker_base, "exec", "-u", "browser-test", container,
                  "python3", "-c", script], env, cwd, 20)
    if result.returncode:
        raise RuntimeError("Could not read isolated Chrome target list: " + result.stderr)
    return json.loads(result.stdout)


def main():
    args = parse_args()
    hermes = Path(args.hermes).resolve()
    node = Path(args.node).resolve() if args.node else None
    release = Path(args.release).resolve()
    if not hermes.is_file() or not node or not node.is_file():
        raise SystemExit("Hermes or Node is missing")
    proxy = validate_proxy(args.base_url)
    docker = shutil.which("docker")
    if not docker:
        raise SystemExit("docker is required")
    docker_prefix = ["--host", args.docker_host] if args.docker_host else []
    docker_base = [docker, *docker_prefix]
    command = [*docker_base, "exec", "-i", "-u", "browser-test", args.container, args.runtime, "--chrome"]
    digest = hashlib.file_digest(hermes.open("rb"), "sha256").hexdigest()
    version = run([str(hermes), "--version"], {}, ROOT).stdout.strip()
    adapter_hash = adapter_digest(release)
    temp_parent = "/private/tmp" if sys.platform == "darwin" else tempfile.gettempdir()
    with tempfile.TemporaryDirectory(prefix="lcu-hermes-browser-", dir=temp_parent) as temporary:
        root = Path(temporary)
        home, hermes_home = root / "home", root / "hermes"
        home.mkdir(); hermes_home.mkdir()
        lifecycle_log = root / "turn-ended.jsonl"
        env = {"PATH": os.pathsep.join([str(hermes.parent), str(node.parent), str(Path(docker).resolve().parent), "/usr/bin", "/bin"]),
               "HOME": str(home), "HERMES_HOME": str(hermes_home), "OPENAI_API_KEY": args.api_key,
               "TERM": "xterm-256color", "NO_COLOR": "1", "NO_PROXY": "localhost,127.0.0.1",
               "no_proxy": "localhost,127.0.0.1", "LCU_HERMES_LIFECYCLE_LOG": str(lifecycle_log)}
        call("harness_setup", "configureHermes", home, command, node, release, {"scope": "user", "env": env})
        instrument_cleanup(hermes_home / "plugins/lcu-cua/__init__.py", lifecycle_log)
        for key, value in (("model.provider", "custom"), ("model.default", args.model),
                           ("model.base_url", args.base_url.rstrip("/")),
                           ("model.api_mode", "chat_completions"), ("agent.max_turns", "12"),
                           ("tools.tool_search.enabled", "false")):
            configured = run([str(hermes), "config", "set", key, value], env, home)
            if configured.returncode:
                raise RuntimeError(f"Hermes config {key} failed: {configured.stderr}{configured.stdout}")
        marker = "hermes-browser-" + uuid.uuid4().hex[:12]
        prompt = ("Use only LCU's original Computer Use js tool. "
                  "First call await cua.getState() and follow its original instructions. In isolated "
                  "Chrome create a tab at " + ORIGIN + "/. Enter exactly " + marker +
                  " in Draft text, click Save draft, verify Saved: " + marker +
                  ". Do not access any other origin or window. Report the exact saved marker.")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 160, 0, 0))
        process = subprocess.Popen([str(hermes), "chat", "--cli", "--provider", "custom",
                                    "--model", args.model, "--toolsets", "lcu_cua",
                                    "--max-turns", "12", "--run-budget", str(args.timeout),
                                    "-q", prompt], stdin=slave, stdout=slave, stderr=slave,
                                   cwd=home, env=env, start_new_session=True)
        os.close(slave)
        captured = bytearray()
        approval_seen = False
        exited_tui = False
        process_exit = None
        failure = None
        target = None
        other = None
        lifecycle = []
        tabs_after_cleanup = None
        try:
            deadline = time.monotonic() + args.timeout
            while time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    captured.extend(data)
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
                rendered = ANSI.sub("", captured.decode("utf-8", "replace"))
                if (not approval_seen and f"Allow Browser use to access {ORIGIN}?" in rendered and
                        "Allow once" in rendered and "Deny" in rendered):
                    # Hermes' native interactive selector has only one-time Allow and Deny.
                    if "Always" in rendered:
                        raise AssertionError("Hermes did not show its once/deny browser-origin selector")
                    os.write(master, b"\r")
                    approval_seen = True
                if lifecycle_log.is_file():
                    lifecycle = [json.loads(line) for line in lifecycle_log.read_text().splitlines() if line]
                if approval_seen and lifecycle and lifecycle[-1].get("event") == "Stop":
                    target = run([*docker_base, "exec", "-u", "browser-test", args.container,
                                  "cat", "/tmp/lcu-browser-output/Target.txt"], env, home, 20)
                    if target.returncode == 0 and target.stdout.strip() == marker:
                        tabs_after_cleanup = browser_page_urls(docker_base, args.container, env, home)
                        if any(url.startswith(ORIGIN + "/") for url in tabs_after_cleanup):
                            raise AssertionError("Original LCU did not close the session-owned browser tab at turn end")
                        exited_tui = True
                        break
                if process.poll() is not None:
                    break
            if not exited_tui:
                raise TimeoutError("Hermes did not complete cleanup, marker write, and browser-tab cleanup before deadline")
            other = run([*docker_base, "exec", "-u", "browser-test", args.container,
                         "test", "-e", "/tmp/lcu-browser-output/Other.txt"], env, home, 20)
            if other.returncode not in (0, 1):
                raise AssertionError("Could not query Other oracle: " + other.stderr)
            if (not approval_seen or target.returncode or target.stdout != marker or
                    other.returncode == 0 or not lifecycle or lifecycle[-1].get("event") != "Stop" or
                    any(url.startswith(ORIGIN + "/") for url in (tabs_after_cleanup or []))):
                raise AssertionError("Hermes browser flow failed; inspect private evidence")
            print(f"PASS Hermes {version}: one-time origin approval, original Chrome save marker {marker}, Other absent")
        except BaseException as error:
            failure = error
            raise
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL); process.wait(5)
            os.close(master)
            if args.evidence_file:
                evidence = {"harness": "hermes", "version": version, "binary_sha256": digest,
                            "adapter_source_sha256": adapter_hash, "lcu_release": str(release),
                            "model": args.model, "proxy_origin": proxy.netloc, "marker": marker,
                            "browser_origin": ORIGIN, "approval_selector_seen": approval_seen,
                            "turn_ended_and_cleanup_observed": exited_tui, "process_exit": process_exit,
                            "lifecycle_cleanup": lifecycle, "page_urls_after_cleanup": tabs_after_cleanup,
                            "target_exit": target.returncode if target else None,
                            "target_text": target.stdout if target else None,
                            "other_exists": other.returncode == 0 if other else None,
                            "failure": str(failure) if failure else None,
                            "terminal_output": ANSI.sub("", captured.decode("utf-8", "replace"))}
                path = Path(args.evidence_file).expanduser().resolve(); path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
