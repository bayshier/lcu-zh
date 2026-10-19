"""Hermes Agent plugin that relays Computer Use to LCU's original MCP runtime."""

from __future__ import annotations

import atexit
import contextvars
import json
import logging
import os
from pathlib import Path
import subprocess
import threading
from typing import Any
from urllib.parse import urlsplit, urlunsplit


PLUGIN_DIR = Path(__file__).resolve().parent
CONFIG_PATH = PLUGIN_DIR / "lcu-config.json"
# Hermes writes logging records to its own log files. Nothing here prints: the Hermes CLI draws its
# TUI on this process's terminal.
LOGGER = logging.getLogger(__name__)
BRIDGE_STDERR_CHARS = 512
# Lines of bridge stderr passed to Hermes' log per bridge; the rest is read and dropped.
BRIDGE_STDERR_LINES = 200


def _warn(message: str, *args: Any) -> None:
    """Log a warning only where a handler will take it, never through logging's stderr fallback."""
    if LOGGER.hasHandlers():
        LOGGER.warning(message, *args)


def _drain_bridge_stderr(stream) -> None:
    """Read the bridge's stderr to the end so it never blocks; keep it off the Hermes terminal.

    The original runtime's own stderr is already recorded (classified, without text) in LCU's
    diagnostic log by the bridge; what is left here is the bridge's own rare messages.
    """
    logged = 0
    try:
        for line in iter(lambda: stream.readline(8192), ""):
            line = line.rstrip()
            # INFO is below logging's last-resort stderr handler, so without Hermes' handlers it is dropped.
            if line and logged < BRIDGE_STDERR_LINES:
                logged += 1
                LOGGER.info("LCU bridge: %s", line[:BRIDGE_STDERR_CHARS])
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


class Bridge:
    """One persistent Node MCP SDK client, kept alive for this Hermes process."""

    def __init__(self, config: dict[str, Any]):
        command = config.get("command")
        node = config.get("node")
        bridge = config.get("bridge")
        if not isinstance(command, list) or not command or any(not isinstance(item, str) or not item for item in command):
            raise ValueError("LCU Hermes config requires a nonempty command argv")
        if not isinstance(node, str) or not Path(node).is_absolute() or not Path(node).is_file():
            raise ValueError("LCU Hermes config requires the absolute selected LCU Node runtime")
        if not isinstance(bridge, str) or not Path(bridge).is_absolute() or not Path(bridge).is_file():
            raise ValueError("LCU Hermes config requires the absolute packaged LCU bridge")
        self.command = command
        self.process = subprocess.Popen(
            [node, bridge], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        # The bridge records the original runtime's stderr in LCU's diagnostic log; the bridge's own
        # stderr is drained here and never inherited by the Hermes TUI.
        threading.Thread(target=_drain_bridge_stderr, args=(self.process.stderr,),
                         name="lcu-hermes-bridge-stderr", daemon=True).start()
        self.lock = threading.Lock()
        self.sequence = 0
        self.closed = False

    def request(self, kind: str, *, on_elicitation=None, **values: Any) -> dict[str, Any]:
        with self.lock:
            if self.closed or self.process.poll() is not None:
                raise RuntimeError("LCU Hermes bridge is closed")
            self.sequence += 1
            request_id = self.sequence
            request = {"id": request_id, "type": kind, **values}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            while True:
                line = self.process.stdout.readline()
                if not line:
                    raise RuntimeError("LCU Hermes bridge ended before returning a result")
                response = json.loads(line)
                if response.get("type") == "elicitation":
                    answer = {"action": "cancel"}
                    if callable(on_elicitation):
                        try:
                            answer = on_elicitation(response.get("params"))
                        except Exception:
                            answer = {"action": "cancel"}
                    self.process.stdin.write(json.dumps({
                        "type": "elicitationResponse", "id": response.get("id"),
                        "response": answer if isinstance(answer, dict) else {"action": "cancel"},
                    }, ensure_ascii=False) + "\n")
                    self.process.stdin.flush()
                    continue
                if response.get("id") != request_id:
                    raise RuntimeError("LCU Hermes bridge returned a mismatched request identity")
                if response.get("ok") is not True:
                    raise RuntimeError(str(response.get("error") or "LCU Hermes bridge request failed"))
                result = response.get("result")
                if not isinstance(result, dict):
                    raise RuntimeError("LCU Hermes bridge returned an invalid result")
                return result

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
            try:
                if self.process.poll() is None and self.process.stdin is not None:
                    # Closing stdin makes the bridge close the original MCP client.
                    self.process.stdin.close()
                self.process.wait(timeout=5)
            except Exception:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except Exception:
                    self.process.kill()


def _result_for_hermes(result: dict[str, Any]) -> str | dict[str, Any]:
    """Preserve text/error results and map original MCP images into Hermes' native image_url envelope."""
    blocks = result.get("content")
    if not isinstance(blocks, list) or not any(
        isinstance(block, dict) and block.get("type") == "image" for block in blocks
    ):
        return json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    rendered = []
    for block in blocks:
        if not isinstance(block, dict):
            rendered.append({"type": "text", "text": json.dumps(block, ensure_ascii=False)})
        elif block.get("type") == "text" and isinstance(block.get("text"), str):
            rendered.append({"type": "text", "text": block["text"]})
        elif block.get("type") == "image" and isinstance(block.get("data"), str) and isinstance(block.get("mimeType"), str):
            rendered.append({"type": "image_url", "image_url": {
                "url": f"data:{block['mimeType']};base64,{block['data']}"
            }})
        else:
            raise ValueError(f"Hermes LCU adapter cannot faithfully forward MCP result block {block.get('type')!r}")
    summary_parts = [part["text"] for part in rendered if part.get("type") == "text"]
    image_types = [block.get("mimeType", "unknown MIME type") for block in blocks
                   if isinstance(block, dict) and block.get("type") == "image"]
    summary_parts.extend(f"[Original image attached as image_url ({mime}); bytes are preserved unchanged.]"
                         for mime in image_types)
    if result.get("isError"):
        rendered.insert(0, {"type": "text", "text": "Original MCP tool result isError=true."})
        summary_parts.insert(0, "Original MCP tool result isError=true.")
    return {
        "_multimodal": True,
        "content": rendered,
        "text_summary": "\n".join(summary_parts),
        **{key: value for key, value in result.items() if key != "content"},
    }


def _approval_choice(message: str, description: str, *, title: str,
                     allow_session: bool, allow_permanent: bool) -> Any:
    """Use Hermes' owning CLI/TUI or gateway approval surface and return its exact choice."""
    from tools import approval_context as approval_ctx
    is_api_run = (approval_ctx._get_session_platform() == "api_server"
                  and not approval_ctx._is_cron_approval_context()
                  and not approval_ctx._is_single_query_approval_context())
    if approval_ctx._is_gateway_approval_context() or is_api_run:
        from tools import approval as approval
        from tools import approval_gateway_wait as gateway_wait
        session_key = approval_ctx.get_current_session_key()
        notify_cb = approval._gateway_notify_cb(session_key)
        if notify_cb is None:
            return "cancel"
        decision = gateway_wait._await_gateway_decision(
            session_key, notify_cb,
            {"command": message, "description": description,
             "pattern_key": "mcp_elicitation", "pattern_keys": ["mcp_elicitation"],
             "allow_session": allow_session, "allow_permanent": allow_permanent},
            surface="mcp-elicitation/lcu")
        if decision.get("notify_failed") or not decision.get("resolved") or decision.get("cancelled"):
            return "cancel"
        return decision.get("choice")
    # Single-query (-z, chat -q) and cron runs have no one to answer, and without a CLI callback
    # prompt_dangerous_approval would read stdin until approvals.timeout. A missing helper raises and cancels.
    cli_callback = approval_ctx._resolve_cli_approval_callback()
    if (approval_ctx._is_cron_approval_context() or approval_ctx._is_single_query_approval_context()
            or cli_callback is None):
        return "cancel"
    from tools.approval_prompt import prompt_dangerous_approval
    choice = prompt_dangerous_approval(
        message, description, allow_session=allow_session, allow_permanent=allow_permanent,
        approval_callback=cli_callback, title=title)
    if choice in {"deny", "decline"}:
        try:
            from tools.interrupt import is_interrupted
            if is_interrupted():
                return "cancel"
        except Exception:
            pass
    return choice


def _present_elicitation(params: Any) -> dict[str, Any]:
    """Present original CUA consent through Hermes' native selector.

    The selected persistence scope is returned to the original runtime. This
    adapter does not write Hermes allowlists or cache grants locally.
    """
    if not isinstance(params, dict) or params.get("mode") != "form":
        return {"action": "cancel"}
    message = params.get("message")
    schema = params.get("requestedSchema", params.get("requested_schema"))
    if not isinstance(message, str) or not message or not isinstance(schema, dict) or schema.get("type") != "object":
        return {"action": "cancel"}
    properties = schema.get("properties", {})
    required = schema.get("required", [])
    if not isinstance(properties, dict) or properties or not isinstance(required, list) or required:
        return {"action": "cancel"}
    metadata = params.get("_meta", params.get("meta", {}))
    metadata = metadata if isinstance(metadata, dict) else {}
    browser_origin = metadata.get("origin")
    if (metadata.get("codex_approval_kind") == "mcp_tool_call" and
            metadata.get("connector_id") == "browser-use" and
            metadata.get("tool_name") == "access_browser_origin" and
            isinstance(browser_origin, str)):
        try:
            parsed = urlsplit(browser_origin)
            canonical = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
            valid_origin = (parsed.scheme in {"http", "https"} and bool(parsed.hostname) and
                            parsed.username is None and parsed.password is None and
                            (parsed.port is None or 1 <= parsed.port <= 65535) and canonical == browser_origin)
        except ValueError:
            valid_origin = False
        if not valid_origin:
            return {"action": "cancel"}
        try:
            answer = _approval_choice(
                message, f"Allow the original Browser Use runtime to access {browser_origin}?",
                allow_session=False, allow_permanent=False,
                title=f"Browser origin approval: {browser_origin}")
        except Exception:
            return {"action": "cancel"}
        if answer == "once":
            return {"action": "accept", "content": {}}
        if answer in {"deny", "decline"}:
            return {"action": "decline"}
        return {"action": "cancel"}
    app = metadata.get("tool_params", {}).get("app") if isinstance(metadata.get("tool_params"), dict) else None
    native = (metadata.get("codex_approval_kind") == "mcp_tool_call" and
              metadata.get("connector_id") == "computer-use" and isinstance(app, str) and bool(app))
    if not native:
        return {"action": "cancel"}
    persist = metadata.get("persist")
    if not isinstance(persist, list) or any(item not in {"session", "always"} for item in persist):
        return {"action": "cancel"}
    persist = set(persist)
    description = f"Original Computer Use request for {app}. The selected scope is sent to the original runtime."
    try:
        answer = _approval_choice(
            message, description, allow_session="session" in persist,
            allow_permanent="always" in persist, title=f"Computer Use approval: {app}")
    except Exception:
        return {"action": "cancel"}
    if answer == "once":
        return {"action": "accept", "content": {}}
    if answer in {"session", "always"} and answer in persist:
        return {"action": "accept", "content": {}, "_meta": {"persist": answer}}
    if answer in {"deny", "decline"}:
        return {"action": "decline"}
    return {"action": "cancel"}


def register(ctx) -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    bridge = Bridge(config)
    on_unload = getattr(ctx, "on_unload", None)
    if callable(on_unload):
        on_unload(bridge.close)
    atexit.register(bridge.close)
    try:
        connected = bridge.request("connect", command=bridge.command)
        upstream_tools = connected.get("tools")
        if not isinstance(upstream_tools, list):
            raise RuntimeError("Original CUA MCP server returned no tool descriptors")
        public = [tool for tool in upstream_tools if isinstance(tool, dict) and tool.get("name") in {"js", "js_reset"}]
        if {tool.get("name") for tool in public} != {"js", "js_reset"}:
            raise RuntimeError("Original CUA js/js_reset tools are missing")
    except BaseException:
        bridge.close()
        raise

    active_turns: dict[str, str] = {}
    pending_cleanups: dict[tuple[str, str], str] = {}
    turn_lock = threading.Lock()
    owner_session: str | None = None
    active_tool_identity = contextvars.ContextVar("lcu_hermes_active_tool_identity", default=None)

    def inject_original_context(session_id="", turn_id="", **kwargs):
        nonlocal connected, owner_session
        del kwargs
        if not isinstance(session_id, str) or not session_id or not isinstance(turn_id, str) or not turn_id:
            return "LCU is unavailable for this Hermes turn because the host did not provide exact session and turn IDs."
        with turn_lock:
            previous_turn = active_turns.get(session_id)
            if previous_turn and previous_turn != turn_id:
                try:
                    result = bridge.request("turnEnded", sessionId=session_id, turnId=previous_turn,
                                            event="Interrupt")
                    if result.get("isError"):
                        raise RuntimeError(_result_for_hermes(result))
                    active_turns.pop(session_id, None)
                except Exception as exc:
                    pending_cleanups[(session_id, previous_turn)] = "Interrupt"
                    active_turns.pop(session_id, None)
                    return f"LCU is unavailable because cleanup for prior turn {previous_turn} failed: {exc}"
            stale = list(pending_cleanups.items())
            for (pending_session, pending_turn), event in stale:
                try:
                    result = bridge.request("turnEnded", sessionId=pending_session, turnId=pending_turn, event=event)
                    if result.get("isError"):
                        raise RuntimeError(_result_for_hermes(result))
                    pending_cleanups.pop((pending_session, pending_turn), None)
                except Exception as exc:
                    return f"LCU is unavailable because cleanup for prior turn {pending_turn} failed: {exc}"
            if owner_session is not None and owner_session != session_id:
                if active_turns:
                    return "LCU is unavailable because another Hermes session still owns the original Computer Use runtime."
                try:
                    bridge.request("close")
                    reconnected = bridge.request("connect", command=bridge.command)
                    if reconnected.get("tools") != connected.get("tools"):
                        return "LCU is unavailable because the original tool descriptors changed during Hermes session handoff."
                    connected = reconnected
                except Exception as exc:
                    owner_session = None
                    return f"LCU could not reconnect the original runtime for this Hermes session: {exc}"
            owner_session = session_id
            active_turns[session_id] = turn_id
        # Like official Codex, the model gets only the original server's
        # instructions and tool descriptors.
        descriptors = json.dumps(public, ensure_ascii=False, indent=2)
        instructions = connected.get("instructions")
        if not isinstance(instructions, str):
            instructions = ""
        return (
            "Use the original installed Computer Use runtime through these LCU tools.\n\n"
            "Original CUA MCP initialization instructions:\n" + instructions + "\n\n"
            "Original public CUA MCP tool descriptors:\n" + descriptors
        )

    def on_session_end(session_id="", turn_id="", interrupted=False, failed=False, **kwargs):
        del kwargs
        if not isinstance(session_id, str) or not session_id:
            return
        with turn_lock:
            active = active_turns.get(session_id)
            if isinstance(turn_id, str) and turn_id:
                if active and turn_id != active and (session_id, turn_id) not in pending_cleanups:
                    return
                if not active and (session_id, turn_id) not in pending_cleanups:
                    return
            exact_turn = turn_id if isinstance(turn_id, str) and turn_id else active
            if exact_turn is None:
                exact_turn = next((turn for (session, turn) in pending_cleanups if session == session_id), None)
        if not exact_turn:
            return
        event = "Interrupt" if interrupted or failed else "Stop"
        try:
            pending_event = pending_cleanups.get((session_id, exact_turn))
            result = bridge.request("turnEnded", sessionId=session_id, turnId=exact_turn,
                                    event=pending_event or event)
            if result.get("isError"):
                raise RuntimeError(_result_for_hermes(result))
            with turn_lock:
                pending_cleanups.pop((session_id, exact_turn), None)
                if active_turns.get(session_id) == exact_turn:
                    active_turns.pop(session_id, None)
        except Exception as exc:
            with turn_lock:
                pending_cleanups[(session_id, exact_turn)] = pending_event or event
                if active_turns.get(session_id) == exact_turn:
                    active_turns.pop(session_id, None)
            # Kept pending: the next turn retries it and tells the model if it still fails.
            _warn("LCU original turn cleanup failed for a Hermes session; it is retried before the next turn: %s",
                  str(exc)[:BRIDGE_STDERR_CHARS])

    def carry_tool_identity(tool_name="", args=None, next_call=None, session_id="", turn_id="",
                            tool_call_id="", **kwargs):
        """Carry exact Hermes tool identity through its real execution callback.

        The host's registry handler dispatch omits turn_id/tool_call_id. Its
        tool_execution middleware receives those IDs and invokes next_call in
        the same context. ContextVar tokens isolate parallel calls and are
        always restored, including when downstream execution raises.
        """
        del args, kwargs
        if not callable(next_call):
            raise RuntimeError("Hermes omitted the downstream tool execution callback")
        if tool_name not in {"js", "js_reset"}:
            return next_call()
        token = active_tool_identity.set((tool_name, session_id, turn_id, tool_call_id))
        try:
            return next_call()
        finally:
            active_tool_identity.reset(token)

    def make_handler(name):
        def handler(params, session_id="", turn_id="", tool_call_id="", **kwargs):
            del kwargs
            hooked_identity = active_tool_identity.get()
            if hooked_identity:
                hook_name, hook_session, hooked_turn, hooked_call = hooked_identity
                if (hook_name != name or hook_session != session_id or
                        (turn_id and turn_id != hooked_turn) or
                        (tool_call_id and tool_call_id != hooked_call)):
                    return json.dumps({"isError": True, "content": [{
                        "type": "text", "text": "LCU rejected this call because Hermes tool execution identity did not match its active callback."
                    }]}, ensure_ascii=False)
                turn_id = turn_id or hooked_turn
                tool_call_id = tool_call_id or hooked_call
            with turn_lock:
                expected_turn = active_turns.get(session_id)
                same_owner = owner_session == session_id
            if not session_id or not turn_id or not same_owner or expected_turn != turn_id:
                return json.dumps({"isError": True, "content": [{
                    "type": "text", "text": "LCU rejected this call because Hermes did not provide the exact active session and turn identity."
                }]}, ensure_ascii=False)
            try:
                result = bridge.request("call", name=name, arguments=params,
                                        sessionId=session_id, turnId=turn_id, toolCallId=tool_call_id,
                                        on_elicitation=_present_elicitation)
                return _result_for_hermes(result)
            except Exception as exc:
                return json.dumps({"isError": True, "content": [{"type": "text", "text": str(exc)}]}, ensure_ascii=False)
        return handler

    for tool in public:
        name = tool["name"]
        schema = {
            "name": name,
            "description": tool.get("description") or "Original LCU Computer Use tool.",
            "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}},
        }
        if ctx.register_tool(name=name, toolset="lcu_cua", schema=schema, handler=make_handler(name)) is None:
            bridge.close()
            raise RuntimeError(f"Hermes could not register LCU tool {name!r}; refusing a conflicting tool registration")

    ctx.register_hook("pre_llm_call", inject_original_context)
    ctx.register_middleware("tool_execution", carry_tool_identity)
    ctx.register_hook("on_session_end", on_session_end)
