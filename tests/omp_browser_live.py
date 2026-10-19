"""Run latest OMP through the original LCU Chrome provider in an isolated container.

This opt-in acceptance runner requires a loopback-only model proxy, the isolated
Chrome fixture container started by harness_browser_session.sh. It drives OMP's real TUI and accepts only the one-time local-origin
approval selector. Evidence belongs outside the repository because OMP output
can contain the original runtime instructions.
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
    p.add_argument("--omp", default=os.environ.get("OMP_BIN"), required=not bool(os.environ.get("OMP_BIN")))
    p.add_argument("--container", default=os.environ.get("OMP_FIXTURE_CONTAINER"), required=not bool(os.environ.get("OMP_FIXTURE_CONTAINER")))
    p.add_argument("--model", default=os.environ.get("OMP_MODEL"), required=not bool(os.environ.get("OMP_MODEL")))
    p.add_argument("--proxy-base-url", default=os.environ.get("OMP_PROXY_BASE_URL"), required=not bool(os.environ.get("OMP_PROXY_BASE_URL")))
    p.add_argument("--docker-host", default=os.environ.get("LCU_DOCKER_HOST"))
    p.add_argument("--runtime", default="/home/browser-test/lcu-current/current/bin/lcu")
    p.add_argument("--release", type=Path, default=ROOT)
    p.add_argument("--evidence-file", default=os.environ.get("OMP_BROWSER_EVIDENCE"))
    p.add_argument("--timeout", type=int, default=240)
    return p.parse_args()


def validate_proxy(raw):
    value = urlsplit(raw)
    host = value.hostname.lower() if value.hostname else ""
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    if value.scheme not in ("http", "https") or not loopback or value.username or value.password or value.fragment:
        raise SystemExit("OMP model proxy must be an HTTP(S) loopback URL without embedded credentials")
    return value


def main():
    args = parse_args()
    omp = Path(args.omp).resolve()
    release = args.release.resolve()
    if not omp.is_file():
        raise SystemExit("OMP executable is missing")
    proxy = validate_proxy(args.proxy_base_url)
    docker = shutil.which("docker")
    node = shutil.which("node")
    if not docker or not node:
        raise SystemExit("docker and node are required")
    prefix = [docker] + (["--host", args.docker_host] if args.docker_host else [])
    lcu_command = [*prefix, "exec", "-i", "-u", "browser-test", args.container, args.runtime, "--chrome"]
    version = subprocess.run([str(omp), "--version"], capture_output=True, text=True, check=True).stdout.strip()
    binary_hash = hashlib.file_digest(omp.open("rb"), "sha256").hexdigest()
    temp_parent = "/private/tmp" if sys.platform == "darwin" else tempfile.gettempdir()
    with tempfile.TemporaryDirectory(prefix="lcu-omp-browser-", dir=temp_parent) as temp:
        root = Path(temp)
        home = root / "home"
        profile = home / ".omp/profiles/lcu-browser/agent"
        profile.mkdir(parents=True)
        for folder in ("config", "data", "cache", "cwd", "session"):
            (root / folder).mkdir()
        cli_model = args.model if "/" in args.model else "openai/" + args.model
        (profile / "models.yml").write_text(
            "providers:\n  openai:\n    api: openai-completions\n"
            f"    baseUrl: {args.proxy_base_url.rstrip('/')}\n"
            "    apiKey: local-fixture-proxy\n    models:\n"
            f"      - id: {args.model.rsplit('/', 1)[-1]}\n"
            "        contextWindow: 200000\n        maxTokens: 8192\n"
            "        supportsTools: true\n        compat:\n          supportsDeveloperRole: false\n",
            encoding="utf-8")
        node_dir = str(Path(node).resolve().parent)
        env = {
            "PATH": os.pathsep.join([str(omp.parent), node_dir, str(Path(docker).resolve().parent), "/usr/bin", "/bin"]),
            "HOME": str(home), "TMPDIR": str(root), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
            "OMP_PROFILE": "lcu-browser", "PI_CODING_AGENT_DIR": str(profile),
            "OPENAI_API_KEY": "local-fixture-proxy", "TERM": "xterm-256color", "NO_COLOR": "1",
            "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1",
        }
        call("harness_setup", "configureOmp", home, lcu_command, release, {"scope": "user", "env": env})
        (profile / "config.yml").write_text("setupVersion: 2\nstartup:\n  quiet: true\n", encoding="utf-8")
        ended = root / "agent-ended.json"
        observer = root / "observer.ts"
        observer.write_text(
            'import {writeFileSync} from "node:fs";\n'
            'export default pi => { pi.on("agent_end", async () => { writeFileSync('
            + json.dumps(str(ended)) + ', JSON.stringify({agent_end:true})); }); };\n')
        marker = "omp-browser-" + uuid.uuid4().hex[:12]
        prompt = ("Use the original Computer Use tools. First call "
                  "await cua.getState() and follow its original instructions. In the isolated "
                  "Chrome browser, create a NEW session tab using cua.createBrowserTab at " + ORIGIN +
                  "/. Do not use an existing tab. Enter exactly " + marker +
                  " in the Draft text field, click Save draft, and verify the page says Saved: " +
                  marker + ". Do not access any other origin or interact with other windows.")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 160, 0, 0))
        process = subprocess.Popen([
            str(omp), "--no-session", "--no-title", "--tools=js,js_reset",
            "--extension", str(observer),
            "--model", cli_model, "--api-key", "local-fixture-proxy", "--thinking=low",
            "--cwd", str(root / "cwd"), "--session-dir", str(root / "session"), prompt,
        ], stdin=slave, stdout=slave, stderr=slave, cwd=root / "cwd", env=env, start_new_session=True)
        os.close(slave)
        captured = bytearray()
        approval_seen = False
        turn_ended = False
        tabs_after_turn = None
        target_result = None
        other_result = None
        exit_code = None
        failure = None
        output_dir = "/tmp/lcu-browser-output"
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
                menu = rendered.rsplit("Allow Browser use to access", 1)[-1]
                if (not approval_seen and "Allow Browser use to access" in rendered and
                        ORIGIN in menu and "Allow" in menu and "Decline" in menu):
                    if "Always" in menu:
                        raise AssertionError("OMP showed an unexpected browser approval selector")
                    # Origin approval exposes only one-time Allow and Decline.
                    os.write(master, b"\r")
                    approval_seen = True
                if ended.exists():
                    turn_ended = True
                    break
                if process.poll() is not None:
                    break
            if not turn_ended:
                raise TimeoutError("OMP did not finish its browser turn before the deadline")
            exit_code = process.poll()
            target = subprocess.run([*prefix, "exec", "-u", "browser-test", args.container,
                                     "cat", output_dir + "/Target.txt"], capture_output=True, text=True, timeout=20)
            target_result = target
            other = subprocess.run([*prefix, "exec", "-u", "browser-test", args.container,
                                    "test", "-e", output_dir + "/Other.txt"], capture_output=True, timeout=20)
            other_result = other
            if other.returncode not in (0, 1):
                raise AssertionError("Could not query browser Other oracle: " + other.stderr.decode(errors="replace"))
            # Read only the disposable browser's target list, independently of
            # the model/runtime. This runs before terminating the harness.
            snapshot = subprocess.run([*prefix, "exec", "-u", "browser-test", args.container,
                "python3", "-c",
                'from pathlib import Path; import json,urllib.request; '
                'port=(Path.home()/".config/lcu-chrome-direct-fixture/DevToolsActivePort").read_text().splitlines()[0]; '
                'tabs=json.load(urllib.request.urlopen("http://127.0.0.1:"+port+"/json/list")); '
                'print(json.dumps([x["url"] for x in tabs if x.get("type")=="page"]))'],
                capture_output=True, text=True, timeout=20, check=True)
            tabs_after_turn = json.loads(snapshot.stdout)
            if any(url.startswith(ORIGIN + "/") for url in tabs_after_turn):
                raise AssertionError("The generated browser tab survived normal turn cleanup")
            evidence = {
                "harness": "oh-my-pi", "version": version, "binary_sha256": binary_hash,
                "model": args.model, "proxy_origin": proxy.netloc, "marker": marker,
                "browser_origin": ORIGIN, "approval_selector_seen": approval_seen,
                "process_exit": exit_code, "target_exit": target.returncode,
                "target_text": target.stdout, "other_exists": other.returncode == 0,
                "terminal_output": ANSI.sub("", captured.decode("utf-8", "replace")),
            }
            if not approval_seen or target.returncode or target.stdout != marker or other.returncode == 0:
                raise AssertionError("OMP browser flow failed; inspect private evidence/output")
            print(f"PASS OMP {version}: one-time origin approval, original Chrome save marker {marker}, Other absent")
        except BaseException as error:
            failure = error
            raise
        finally:
            try:
                if process.poll() is None:
                    process.terminate()
                    process.wait(5)
            except (ProcessLookupError, PermissionError):
                pass
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(5)
            os.close(master)
            if args.evidence_file:
                evidence = {
                    "harness": "oh-my-pi", "version": version, "binary_sha256": binary_hash,
                    "adapter_sha256": hashlib.sha256((release / 'adapters/pi/index.ts').read_bytes()).hexdigest(),
                    "client_sha256": hashlib.sha256((release / 'adapters/client.mjs').read_bytes()).hexdigest(),
                    "adapter_release": str(release),
                    "model": args.model, "proxy_origin": proxy.netloc, "marker": marker,
                    "browser_origin": ORIGIN, "approval_selector_seen": approval_seen,
                    "agent_end_observed": turn_ended, "process_exit_before_cleanup": exit_code,
                    "page_urls_after_turn_before_process_exit": tabs_after_turn,
                    "target_exit": target_result.returncode if target_result else None,
                    "target_text": target_result.stdout if target_result else None,
                    "other_exists": other_result.returncode == 0 if other_result else None,
                    "failure": str(failure) if failure else None,
                    "terminal_output": ANSI.sub("", captured.decode("utf-8", "replace")),
                }
                out = Path(args.evidence_file).expanduser().resolve()
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
