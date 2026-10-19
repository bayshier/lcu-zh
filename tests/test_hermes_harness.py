import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "adapters" / "hermes"

SOURCE_ADAPTERS = ROOT / "adapters"
INSTALLED_ADAPTERS = Path("/opt/lcu/current/adapters")


# The bridges these tests start would otherwise write to the developer's real diagnostic log.
_log_env = patch.dict(os.environ, {"LCU_DIAGNOSTIC_LOG": "0"})


def setUpModule():
    _log_env.start()


def tearDownModule():
    _log_env.stop()


class FakeContext:
    def __init__(self):
        self.tools = {}
        self.hooks = {}
        self.middleware = {}
        self.unload_callbacks = []

    def register_tool(self, *, name, toolset, schema, handler):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}
        return object()

        return object()

    def on_unload(self, callback):
        self.unload_callbacks.append(callback)
        return object()

    def unload(self):
        for callback in reversed(self.unload_callbacks):
            callback()

    def register_hook(self, event, handler):
        self.hooks[event] = handler

    def register_middleware(self, kind, callback):
        self.middleware[kind] = callback
        return object()


class HermesHarnessTests(unittest.TestCase):
    def make_adapter_tree(self, home):
        """Run fixtures beside the built release dependencies; source checkouts omit node_modules."""
        installed = INSTALLED_ADAPTERS if (INSTALLED_ADAPTERS / "node_modules/@modelcontextprotocol/sdk/package.json").is_file() else SOURCE_ADAPTERS
        adapter_root = home / "adapter" / "adapters"
        (adapter_root / "hermes").mkdir(parents=True)
        (adapter_root / "test").mkdir()
        for name in ("client.mjs", "audio-files.mjs", "diagnostics.mjs", "host-guard.mjs"):
            shutil.copy2(installed / name, adapter_root / name)
        for name in ("bridge.mjs",):
            shutil.copy2(installed / "hermes" / name, adapter_root / "hermes" / name)
        shutil.copy2(SOURCE_ADAPTERS / "test" / "hermes-mcp-fixture.mjs",
                     adapter_root / "test" / "hermes-mcp-fixture.mjs")
        (adapter_root / "node_modules").symlink_to(installed / "node_modules", target_is_directory=True)
        if INSTALLED_ADAPTERS.exists():
            node = Path("/opt/lcu/current/agent-tools/node/bin/node")
        else:
            node = Path(shutil.which("node") or "")
        node = node.resolve()
        self.assertTrue(node.is_file(), f"selected Hermes test Node is missing: {node}")
        return adapter_root, node

    def test_plugin_relays_real_turn_identity_results_instructions_and_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="lcu-hermes-test-") as temporary:
            home = Path(temporary)
            plugin_dir = home / "plugins" / "lcu-cua"
            plugin_dir.mkdir(parents=True)
            shutil.copy2(PLUGIN / "__init__.py", plugin_dir / "__init__.py")
            log = home / "fixture.jsonl"
            adapter_root, node = self.make_adapter_tree(home)
            config = {
                "command": [str(node), str(adapter_root / "test/hermes-mcp-fixture.mjs")],
                "node": str(node),
                "bridge": str(adapter_root / "hermes/bridge.mjs"),
            }
            (plugin_dir / "lcu-config.json").write_text(json.dumps(config), encoding="utf-8")
            spec = importlib.util.spec_from_file_location("lcu_hermes_test_plugin", plugin_dir / "__init__.py")
            plugin = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(plugin)
            context = FakeContext()
            previous_log = os.environ.get("LCU_FIXTURE_LOG")
            os.environ["LCU_FIXTURE_LOG"] = str(log)
            try:
                plugin.register(context)
                self.assertEqual(set(context.tools), {"js", "js_reset"})
                self.assertEqual(context.tools["js"]["schema"]["description"], "Original JS description.")
                injected = context.hooks["pre_llm_call"](
                    session_id="hermes-session", turn_id="hermes-turn")
                # Like official Codex: original instructions and descriptors only, no skill.
                self.assertNotIn("SKILL.md", injected)
                self.assertIn("Original CUA initialization guide.", injected)
                self.assertIn('"name": "js"', injected)

                def invoke_lcu(name, params, call_id):
                    # Mirror Hermes' public tool_execution contract: the
                    # handler receives session_id/task_id, while exact turn
                    # and call IDs are present only in middleware context.
                    handler = context.tools[name]["handler"]
                    middleware = context.middleware["tool_execution"]
                    return middleware(
                        tool_name=name, args=params, original_args=params,
                        session_id="hermes-session", turn_id="hermes-turn",
                        tool_call_id=call_id,
                        next_call=lambda next_args=None: handler(
                            params if next_args is None else next_args,
                            session_id="hermes-session", task_id="hermes-task"),
                    )

                raw = invoke_lcu("js", {"code": "context"}, "hermes-call")
                result = json.loads(raw)
                self.assertEqual(result["content"], [{"type": "text", "text": "context"}])
                # A subsequent unwrapped handler call cannot reuse the
                # previous call's ContextVar identity.
                stale = context.tools["js"]["handler"](
                    {"code": "stale"}, session_id="hermes-session", task_id="hermes-task")
                self.assertTrue(json.loads(stale)["isError"])

                approvals = []
                approval_module = types.ModuleType("tools.approval_prompt")
                approval_module.prompt_dangerous_approval = lambda message, description, **kwargs: (
                    approvals.append((message, description, kwargs)) or "session")
                approval_context = types.ModuleType("tools.approval_context")
                approval_context._get_session_platform = lambda: "cli"
                approval_context._is_cron_approval_context = lambda: False
                approval_context._is_single_query_approval_context = lambda: False
                approval_context._is_gateway_approval_context = lambda: False
                approval_context._resolve_cli_approval_callback = lambda: "hermes-native-callback"
                tools_module = types.ModuleType("tools")
                tools_module.__path__ = []
                with patch.dict(sys.modules, {
                    "tools": tools_module, "tools.approval_prompt": approval_module,
                    "tools.approval_context": approval_context,
                }):
                    approval_raw = invoke_lcu("js", {"code": "approval-native"}, "approval-call")
                approval_result = json.loads(approval_raw)
                self.assertEqual(json.loads(approval_result["content"][0]["text"]), {
                    "action": "accept", "content": {}, "_meta": {"persist": "session"}})
                self.assertIn("dev.lcu.fixture", approvals[0][1])
                self.assertTrue(approvals[0][2]["allow_session"])
                self.assertTrue(approvals[0][2]["allow_permanent"])
                self.assertEqual(approvals[0][2]["approval_callback"], "hermes-native-callback")
                self.assertEqual(approvals[0][2]["title"], "Computer Use approval: dev.lcu.fixture")

                selected = {"value": "once"}
                approval_module.prompt_dangerous_approval = lambda message, description, **kwargs: (
                    approvals.append((message, description, kwargs)) or selected["value"])
                for scope, expected in (
                    ("once", {"action": "accept", "content": {}}),
                    ("always", {"action": "accept", "content": {}, "_meta": {"persist": "always"}}),
                    ("decline", {"action": "decline"}),
                    ("cancelled", {"action": "cancel"}),
                ):
                    selected["value"] = scope
                    with patch.dict(sys.modules, {
                        "tools": tools_module, "tools.approval_prompt": approval_module,
                        "tools.approval_context": approval_context,
                    }):
                        response = invoke_lcu("js", {"code": "approval-native"}, f"approval-{scope}")
                    self.assertEqual(json.loads(json.loads(response)["content"][0]["text"]), expected)
                self.assertNotIn("timeout_seconds", approvals[-1][2])

                selected["value"] = "once"
                with patch.dict(sys.modules, {
                    "tools": tools_module, "tools.approval_prompt": approval_module,
                    "tools.approval_context": approval_context,
                }):
                    origin_response = invoke_lcu("js", {"code": "approval-origin"}, "origin-approval")
                self.assertEqual(json.loads(json.loads(origin_response)["content"][0]["text"]),
                                 {"action": "accept", "content": {}})
                self.assertFalse(approvals[-1][2]["allow_session"])
                self.assertFalse(approvals[-1][2]["allow_permanent"])

                gateway_context = types.ModuleType("tools.approval_context")
                gateway_context._get_session_platform = lambda: "telegram"
                gateway_context._is_cron_approval_context = lambda: False
                gateway_context._is_single_query_approval_context = lambda: False
                gateway_context._is_gateway_approval_context = lambda: True
                gateway_context.get_current_session_key = lambda: "fixture-gateway-session"
                gateway_approval = types.ModuleType("tools.approval")
                gateway_approval._gateway_notify_cb = lambda session: (lambda data: None)
                gateway_wait = types.ModuleType("tools.approval_gateway_wait")
                gateway_data = []
                gateway_choice = {"value": "always"}
                def gateway_decision(session, notify, data, *, surface):
                    gateway_data.append((session, data, surface))
                    return {"resolved": True, "choice": gateway_choice["value"]}
                gateway_wait._await_gateway_decision = gateway_decision
                gateway_tools = types.ModuleType("tools")
                gateway_tools.__path__ = []
                native_params = {
                    "mode": "form", "message": "Allow fixture?",
                    "requestedSchema": {"type": "object", "properties": {}},
                    "_meta": {"codex_approval_kind": "mcp_tool_call", "connector_id": "computer-use",
                              "persist": ["session", "always"],
                              "tool_params": {"app": "dev.lcu.fixture"}},
                }
                with patch.dict(sys.modules, {
                    "tools": gateway_tools, "tools.approval_context": gateway_context,
                    "tools.approval": gateway_approval, "tools.approval_gateway_wait": gateway_wait,
                }):
                    self.assertEqual(plugin._present_elicitation(native_params), {
                        "action": "accept", "content": {}, "_meta": {"persist": "always"}})
                    gateway_choice["value"] = "session"
                    self.assertEqual(plugin._present_elicitation(native_params), {
                        "action": "accept", "content": {}, "_meta": {"persist": "session"}})
                    self.assertEqual(gateway_data[-1][0], "fixture-gateway-session")
                    self.assertTrue(gateway_data[-1][1]["allow_session"])
                    self.assertTrue(gateway_data[-1][1]["allow_permanent"])
                    self.assertEqual(gateway_data[-1][2], "mcp-elicitation/lcu")

                form_raw = invoke_lcu("js", {"code": "approval-form"}, "form-call")
                self.assertEqual(json.loads(json.loads(form_raw)["content"][0]["text"])["action"], "cancel")

                image_result = invoke_lcu("js", {"code": "image"}, "image-call")
                self.assertEqual(image_result["content"][1]["image_url"]["url"],
                                 "data:image/png;base64,AAECAw==")
                self.assertNotIn("AAECAw==", image_result["text_summary"])
                audio_raw = invoke_lcu("js", {"code": "audio"}, "audio-call")
                audio_text = json.loads(audio_raw)["content"][0]["text"]
                self.assertIn("Audio result (original MIME type: audio/wav) saved to ", audio_text)
                audio_path = Path(audio_text.rsplit(" ", 1)[-1])
                try:
                    self.assertEqual(audio_path.read_bytes(), b"\0\0\0")
                finally:
                    audio_dir = audio_path.parent
                    audio_path.unlink(missing_ok=True)
                    audio_dir.rmdir()
                blocked = context.hooks["pre_llm_call"](
                    session_id="concurrent-session", turn_id="other-turn")
                self.assertIn("another Hermes session still owns", blocked)

                context.hooks["on_session_end"](session_id="hermes-session", completed=True, interrupted=False)
                context.hooks["pre_llm_call"](session_id="cleanup-once", turn_id="cleanup-turn")
                context.hooks["on_session_end"](session_id="cleanup-once", turn_id="cleanup-turn",
                                                 completed=True, interrupted=False)
                context.hooks["pre_llm_call"](session_id="next-session", turn_id="next-turn")
                entries = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
                call = next(item for item in entries if item.get("name") == "js")
                metadata = call["meta"]["x-codex-turn-metadata"]
                self.assertEqual(metadata["session_id"], "hermes-session")
                self.assertEqual(metadata["turn_id"], "hermes-turn")
                self.assertEqual(metadata["call_id"], "hermes-call")
                cleanup = next(item for item in entries if item.get("name") == "turn_ended")
                self.assertEqual(cleanup["args"]["hook_event_name"], "Stop")
                self.assertEqual(cleanup["args"]["turn_id"], "hermes-turn")
                retries = [item for item in entries if item.get("name") == "turn_ended" and
                           item["args"].get("session_id") == "cleanup-once"]
                self.assertEqual([item["args"]["hook_event_name"] for item in retries], ["Stop", "Stop"])
                self.assertEqual(retries[0]["args"]["turn_id"], "cleanup-turn")
                self.assertEqual(set(context.hooks), {"pre_llm_call", "on_session_end"})
                self.assertIn("tool_execution", context.middleware)
            finally:
                if "context" in locals():
                    context.unload()
                if previous_log is None:
                    os.environ.pop("LCU_FIXTURE_LOG", None)
                else:
                    os.environ["LCU_FIXTURE_LOG"] = previous_log

    def test_headless_contexts_cancel_approval_without_prompting(self):
        spec = importlib.util.spec_from_file_location("lcu_hermes_headless", PLUGIN / "__init__.py")
        plugin = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(plugin)
        prompts = []
        approval_module = types.ModuleType("tools.approval_prompt")
        approval_module.prompt_dangerous_approval = lambda *args, **kwargs: (
            prompts.append(kwargs) or "once")
        tools_module = types.ModuleType("tools")
        tools_module.__path__ = []
        native_params = {
            "mode": "form", "message": "Allow fixture?",
            "requestedSchema": {"type": "object", "properties": {}},
            "_meta": {"codex_approval_kind": "mcp_tool_call", "connector_id": "computer-use",
                      "persist": ["session"], "tool_params": {"app": "dev.lcu.fixture"}},
        }
        cases = {
            "single query": dict(single=True, callback=None),
            "single query with callback": dict(single=True, callback="callback"),
            "cron": dict(cron=True, callback=None),
            "no callback": dict(callback=None),
            "missing helper": dict(callback="callback", omit="_is_single_query_approval_context"),
        }
        for name, case in cases.items():
            with self.subTest(name):
                approval_context = types.ModuleType("tools.approval_context")
                approval_context._get_session_platform = lambda: "cli"
                approval_context._is_cron_approval_context = lambda case=case: case.get("cron", False)
                approval_context._is_single_query_approval_context = lambda case=case: case.get("single", False)
                approval_context._is_gateway_approval_context = lambda: False
                approval_context._resolve_cli_approval_callback = lambda case=case: case["callback"]
                if "omit" in case:
                    delattr(approval_context, case["omit"])
                with patch.dict(sys.modules, {
                    "tools": tools_module, "tools.approval_prompt": approval_module,
                    "tools.approval_context": approval_context,
                }):
                    self.assertEqual(plugin._present_elicitation(native_params), {"action": "cancel"})
        self.assertEqual(prompts, [])

    def test_missing_exact_turn_identity_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="lcu-hermes-test-") as temporary:
            home = Path(temporary)
            plugin_dir = home / "plugins" / "lcu-cua"
            plugin_dir.mkdir(parents=True)
            shutil.copy2(PLUGIN / "__init__.py", plugin_dir / "__init__.py")
            adapter_root, node = self.make_adapter_tree(home)
            (plugin_dir / "lcu-config.json").write_text(json.dumps({
                "command": [str(node), str(adapter_root / "test/hermes-mcp-fixture.mjs")], "node": str(node),
                "bridge": str(adapter_root / "hermes/bridge.mjs"),
            }), encoding="utf-8")
            spec = importlib.util.spec_from_file_location("lcu_hermes_missing_context", plugin_dir / "__init__.py")
            plugin = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(plugin)
            context = FakeContext()
            try:
                plugin.register(context)
                injected = context.hooks["pre_llm_call"]()
                self.assertIn("did not provide exact session and turn IDs", injected)
                raw = context.tools["js"]["handler"]({"code": "must-not-run"})
                self.assertTrue(json.loads(raw)["isError"])
            finally:
                context.unload()

    def test_bridge_and_cleanup_output_stay_off_the_hermes_terminal(self):
        """The Hermes CLI draws its TUI on the plugin process's stderr: nothing from LCU may land there."""
        with tempfile.TemporaryDirectory(prefix="lcu-hermes-stderr-") as temporary:
            home = Path(temporary)
            plugin_dir = home / "plugins" / "lcu-cua"
            plugin_dir.mkdir(parents=True)
            shutil.copy2(PLUGIN / "__init__.py", plugin_dir / "__init__.py")
            adapter_root, node = self.make_adapter_tree(home)
            (plugin_dir / "lcu-config.json").write_text(json.dumps({
                "command": [str(node), str(adapter_root / "test/hermes-mcp-fixture.mjs")], "node": str(node),
                "bridge": str(adapter_root / "hermes/bridge.mjs"),
            }), encoding="utf-8")
            # Every Node process (the bridge and the original fixture) first writes 2 MB to stderr
            # with blocking writes, so a pipe nobody drains would hang registration.
            flood = home / "flood.mjs"
            flood.write_text(
                "import { writeSync } from 'node:fs';\n"
                "const line = 'LCU-FLOOD-TEXT ' + 'x'.repeat(200) + '\\n';\n"
                "for (let i = 0; i < 10000; i++) writeSync(2, line);\n", encoding="utf-8")
            script = (
                "import importlib.util, json, logging, sys\n"
                f"sys.path.insert(0, {str(ROOT / 'tests')!r})\n"
                "from test_hermes_harness import FakeContext\n"
                "if len(sys.argv) > 1:\n"
                "    logging.basicConfig(filename=sys.argv[1], level=logging.INFO)\n"
                "spec = importlib.util.spec_from_file_location("
                f"'lcu_hermes_stderr', {str(plugin_dir / '__init__.py')!r})\n"
                "plugin = importlib.util.module_from_spec(spec)\n"
                "spec.loader.exec_module(plugin)\n"
                "context = FakeContext()\n"
                "plugin.register(context)\n"
                "context.hooks['pre_llm_call'](session_id='cleanup-once', turn_id='turn-1')\n"
                "context.hooks['on_session_end'](session_id='cleanup-once', turn_id='turn-1')\n"
                "retried = context.hooks['pre_llm_call'](session_id='cleanup-once', turn_id='turn-2')\n"
                "context.unload()\n"
                "print(json.dumps({'retried': 'Original CUA initialization guide.' in retried}))\n"
            )
            env = {**os.environ, "LCU_DIAGNOSTIC_LOG": "0",
                   "NODE_OPTIONS": f"--import={flood.as_uri()}"}
            hermes_log = home / "hermes.log"
            for arguments in ([], [str(hermes_log)]):
                with self.subTest(logging_configured=bool(arguments)):
                    run = subprocess.run([sys.executable, "-c", script, *arguments], env=env, cwd=home,
                                         capture_output=True, text=True, timeout=60)
                    self.assertEqual(run.returncode, 0, run.stderr[-2000:])
                    self.assertEqual(run.stderr, "")
                    self.assertEqual(json.loads(run.stdout), {"retried": True})
            logged = hermes_log.read_text(encoding="utf-8")
            self.assertIn("LCU original turn cleanup failed for a Hermes session", logged)
            # The bridge's own stderr reaches Hermes' log, bounded per bridge.
            self.assertIn("LCU bridge: LCU-FLOOD-TEXT", logged)
            self.assertEqual(logged.count("LCU bridge:"), 200)  # BRIDGE_STDERR_LINES


if __name__ == "__main__":
    unittest.main()
