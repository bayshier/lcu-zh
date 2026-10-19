import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  APPROVAL_TIMEOUT_MS,
  callTimeout,
  callWithDeadline,
  createApprovalBroker,
  createApprovalGate,
  createApprovalLogger,
  createCallTracker,
  isMainModule,
  nativeAppApprovalOptions,
  nativeAppApprovalResponse,
  relayElicitation,
  TURN_END_TIMEOUT_MS,
} from './client.mjs';
import { crossTurnEnabled } from './cross-turn.mjs';
import { openDiagnosticLog } from './diagnostics.mjs';
import { declineAgentHostApp } from './host-guard.mjs';

const PUBLIC_TOOLS = new Set(['js', 'js_reset']);
const CONTEXT_TOOL = 'set_turn_context';
const APPROVAL_REQUEST_TOOL = 'approval_request';
const APPROVAL_CHOICE_TOOL = 'approval_choice';
const TURN_END_TOOL = 'turn_ended';
/** Listed for the lcu-approve mod but never allowed or denied in Claude's permissions; refused without a plugin tool-use id. */
const MOD_ONLY_TOOLS = new Set(['approval_request', 'approval_choice']);
const TURN_CONTEXT_META = 'x-codex-turn-metadata';
const CLAUDE_TOOL_USE_META = 'claudecode/toolUseId';
/**
 * Once the host is gone, Interrupt cleanup for its open turns gets this long before the original server is
 * closed anyway, so a relay whose host exited or was killed ends within seconds, not after the cleanup's own
 * timeouts (20 s per step on macOS) or after an in-flight call.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
/** Live (bound, not yet ended) turns a relay accepts at once. */
const MAX_LIVE_TURNS = 1024;
/**
 * Ended keys and closed prompts are remembered oldest-first up to this many each, which keeps long sessions
 * bounded without ever refusing work or cleanup. After eviction an extremely old key or prompt falls back to the
 * prior behavior: a cross-turn-off child of a prompt closed this long ago is no longer refused here, and a
 * cross-turn-on rebind of an evicted key forwards its prompt id (which upstream may refuse).
 */
export const MAX_ENDED_TURNS = 65_536;
const TURN_CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    session_id: { type: 'string', minLength: 1 },
    turn_id: { type: 'string', minLength: 1 },
    tool_use_id: { type: 'string', minLength: 1 },
    agent_id: { type: 'string' },
  },
  required: ['session_id', 'turn_id', 'tool_use_id'],
  additionalProperties: false,
};

const APPROVAL_REQUEST_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string', minLength: 1 } },
  required: ['message'],
  additionalProperties: false,
};
const APPROVAL_CHOICE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    choice: { type: 'string', enum: ['session', 'always', 'deny', 'cancel'] },
  },
  required: ['id', 'choice'],
  additionalProperties: false,
};

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function turnKey(sessionId, turnId) {
  return JSON.stringify([sessionId, turnId]);
}

/**
 * A subagent's own upstream turn id: a hash of its exact (agent, prompt) key formatted as a UUID. It needs no
 * map, so a SubagentStop can never end the parent's prompt id, which the original service shares across sessions.
 */
export function subagentTurnId(agentId, promptId) {
  const hex = createHash('sha256').update(JSON.stringify([agentId, promptId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function asError(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireTurnContext(value) {
  if (!value || typeof value !== 'object' ||
      !nonEmptyString(value.session_id) || !nonEmptyString(value.turn_id) ||
      !nonEmptyString(value.tool_use_id) ||
      (value.agent_id !== undefined && typeof value.agent_id !== 'string')) {
    throw new Error('Claude turn context requires session_id, turn_id, and tool_use_id');
  }
  return {
    sessionId: value.session_id,
    turnId: value.turn_id,
    toolUseId: value.tool_use_id,
    ...(typeof value.agent_id === 'string' && value.agent_id ? { agentId: value.agent_id } : {}),
  };
}

function nativeForm(params, approval) {
  const choices = approval.choices;
  return {
    ...params,
    mode: 'form',
    message: approval.message,
    requestedSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: choices.map(choice => choice.value),
          enumNames: choices.map(choice => choice.label),
        },
      },
      required: ['choice'],
    },
  };
}

/**
 * Run a Claude-facing MCP server that relays the selected original LCU server.
 * The relay leaves public tool descriptors, instructions, and result blocks
 * with the original server and changes only the host-specific identity seams.
 */
export async function runClaudeBridge({
  command, args = [], cwd, env, log = openDiagnosticLog({ adapter: 'claude' }),
  shutdownDrainMs = SHUTDOWN_DRAIN_TIMEOUT_MS, crossTurn = () => crossTurnEnabled(),
  maxEndedTurns = MAX_ENDED_TURNS,
} = {}) {
  if (!nonEmptyString(command) || !Array.isArray(args) ||
      args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Claude bridge requires the original MCP command and string arguments');
  }

  const upstreamTransport = new StdioClientTransport({
    command,
    args,
    ...(cwd ? { cwd } : {}),
    env: env ?? process.env,
    stderr: 'inherit',
  });
  const upstream = new Client({ name: 'lcu-claude-relay', version: '0.1.0' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  const contexts = new Map();
  // One record per life of a turn key (session or agent, prompt id), created at bind and carried by every
  // context and call of that life: { key, sessionId, turnId, subagent, upstreamId, endedUpstream, cleanup, ended,
  // worker }.
  // `upstreamId` is the turn id the original service sees for this life, so cleanup always targets its own life.
  // `endedUpstream` is set whenever that id is known or assumed ended (the host reported this life's end, a
  // parent's end cascaded to it, or it inherited a closed prompt id), whatever the cleanup answered.
  // `worker` is the original trusted worker generation this life last ran `js` on (undefined if none since its
  // last reset); `js_reset` stops that worker, and with it the turn-ended hook and pending turn data it holds.
  const lives = new Map();
  let worker = 0;
  // Keys this relay bound whose last life ended, and prompts a main Stop or Interrupt closed; one entry each.
  const endedKeys = new Set();
  const endedPrompts = new Set();
  const remember = (set, value) => {
    set.delete(value);
    set.add(value);
    if (set.size > maxEndedTurns) set.delete(set.values().next().value);
  };
  // Every upstream turn_ended still awaiting its reply, so shutdown can wait for superseded ones too.
  const pendingEnds = new Set();
  const sendTurnEnded = (event, sessionId, upstreamId) => {
    const call = upstream.callTool({ name: TURN_END_TOOL, arguments: {
      hook_event_name: event, session_id: sessionId, turn_id: upstreamId,
    } }, undefined, { timeout: TURN_END_TIMEOUT_MS });
    pendingEnds.add(call);
    const forget = () => pendingEnds.delete(call);
    call.then(forget, forget);
    return call;
  };
  let server;
  const approvals = createApprovalGate();
  const broker = createApprovalBroker();
  const calls = createCallTracker(log);
  const approvalLog = createApprovalLogger(log, calls);
  const loggedApprovals = new Map();
  let liveCalls = 0;
  let connected = false;
  let shutdown;
  let serverClose;

  const clearLifeContexts = (life) => {
    for (const [toolUseId, context] of contexts) {
      if (context.life === life) contexts.delete(toolUseId);
    }
  };

  // Only live state is capped: a new turn is refused rather than exceed it.
  const admit = (key) => {
    if (!lives.has(key) && lives.size >= MAX_LIVE_TURNS) {
      throw new Error('Too many active Claude turns; LCU rejected this call safely');
    }
  };

  const openLife = (key, sessionId, turnId, subagent, upstreamId) => {
    const life = { key, sessionId, turnId, subagent, upstreamId, endedUpstream: endedPrompts.has(upstreamId),
      cleanup: null, ended: false, worker: undefined };
    lives.set(key, life);
    endedKeys.delete(key);
    return life;
  };

  async function turnEnded(life, event) {
    if (life.ended) return { content: [{ type: 'text', text: 'Turn already ended.' }] };
    const { key, sessionId, turnId } = life;
    const started = Date.now();
    let outcome = 'error';
    let cleanup = life.cleanup;
    let children = [];
    life.endedUpstream = true;
    if (!cleanup) {
      if (!life.subagent) {
        // The host reported the prompt's end: close it here and now, whatever upstream answers, so no subagent
        // can run on it afterwards (cross-turn off). Never rolled back; an unclear reply fails closed.
        remember(endedPrompts, turnId);
        if (!crossTurn()) {
          // Cross-turn off keeps today's behavior: the prompt's subagents shared its upstream id, so they ended
          // with it. Their ids are captured now, before any await or re-bind can change them, and each such
          // life counts as ended so a later cross-turn-on re-bind renews it.
          children = [...lives.values()].filter(child => child.subagent && child.turnId === turnId);
          children = children.map(child => {
            const captured = { sessionId: child.sessionId, upstreamId: child.upstreamId };
            // From now on the child's pending and later calls carry the closed prompt id, never its live hash.
            child.endedUpstream = true;
            child.upstreamId = turnId;
            return captured;
          });
        }
      }
      cleanup = sendTurnEnded(event, sessionId, life.upstreamId);
      life.cleanup = cleanup;
    }
    try {
      const result = await cleanup;
      if (result.isError) {
        const detail = (result.content ?? []).filter(item => item.type === 'text')
          .map(item => item.text).join('\n');
        throw new Error(`Original CUA turn cleanup failed: ${detail || 'unknown error'}`);
      }
      life.ended = true;
      // A re-bound key belongs to a newer life; only this life's own state goes.
      if (lives.get(key) === life) {
        lives.delete(key);
        remember(endedKeys, key);
      }
      clearLifeContexts(life);
      outcome = 'ok';
      return result;
    } finally {
      log.event('turn_end', { hook_event: event, ms: Date.now() - started, outcome, sky_hook: skyHook(life) });
      if (life.cleanup === cleanup && !life.ended) life.cleanup = null;
      // Only upstream is told about the children; their own Stop still cleans up the relay.
      for (const child of children) {
        try {
          await sendTurnEnded(event === 'Stop' ? 'SubagentStop' : 'Interrupt', child.sessionId, child.upstreamId);
        } catch (error) {
          console.error('Claude MCP subagent cleanup failed:', asError(error));
        }
      }
    }
  }

  // Whether a turn end can reach Sky: 'live' when the worker this life ran js on still runs (its turn-ended hook
  // gets the signal), 'reset' when that worker was reset since (nothing receives it, Sky keeps the turn's event
  // taps), 'none' when the life ran no js on any worker since its last reset.
  function skyHook(life) {
    if (life.worker === undefined) return 'none';
    return life.worker === worker ? 'live' : 'reset';
  }

  // js_reset stops the original trusted worker, which holds the turn-ended hook and the pending turn data of every
  // turn that ran js on it: a later turn end would reach nobody and Sky would keep those turns' event taps. Each
  // such life ends upstream first, while the worker still lives, then continues under a fresh upstream id so its
  // later calls are not refused as calls of an ended turn. sendTurnEnded, not turnEnded: a main life's reset
  // must not close the prompt for its subagents.
  async function endWorkerTurns() {
    const used = [...lives.values()].filter(life => life.worker === worker && !life.endedUpstream && !life.cleanup);
    worker++;
    await Promise.all(used.map(async life => {
      const started = Date.now();
      let outcome = 'error';
      try {
        const result = await sendTurnEnded('Interrupt', life.sessionId, life.upstreamId);
        if (!result.isError) outcome = 'ok';
      } catch (error) {
        console.error('Claude MCP turn cleanup before js_reset failed:', asError(error));
      } finally {
        log.event('turn_end', { hook_event: 'Interrupt', cause: 'js_reset', ms: Date.now() - started, outcome,
          sky_hook: 'live' });
      }
      life.upstreamId = randomUUID();
      life.worker = undefined;
    }));
  }

  // The life a Stop, SubagentStop or hook Interrupt ends: the key's current one.
  function lifeForHook(sessionId, turnId, event) {
    if (!nonEmptyString(sessionId) || !nonEmptyString(turnId) ||
        !['Stop', 'Interrupt', 'SubagentStop'].includes(event)) {
      throw new Error('Claude lifecycle cleanup requires an exact session, prompt, and supported event');
    }
    const key = turnKey(sessionId, turnId);
    // Every valid main Stop or Interrupt recommits the prompt's closure, even one that is then deduplicated.
    if (event !== 'SubagentStop') remember(endedPrompts, turnId);
    const current = lives.get(key);
    if (current) return current;
    if (endedKeys.has(key)) return undefined;
    // A key this relay never bound is still ended upstream, so record it: a first bind with cross-turn on
    // must renew instead of forwarding the ended id. The history is bounded oldest-first.
    remember(endedKeys, key);
    const subagent = event === 'SubagentStop';
    return { key, sessionId, turnId, subagent, upstreamId: subagent ? subagentTurnId(sessionId, turnId) : turnId,
      endedUpstream: true, cleanup: null, ended: false };
  }

  try {
    const connectStarted = Date.now();
    try {
      await upstream.connect(upstreamTransport);
    } catch (error) {
      log.event('upstream_connect', { ms: Date.now() - connectStarted, ok: false });
      throw error;
    }
    connected = true;
    log.event('upstream_connect', { ms: Date.now() - connectStarted, ok: true });
    const listed = await upstream.listTools();
    const upstreamTools = listed.tools;
    const publicTools = upstreamTools.filter(tool => PUBLIC_TOOLS.has(tool.name));
    if (publicTools.length !== PUBLIC_TOOLS.size ||
        !upstreamTools.some(tool => tool.name === TURN_END_TOOL)) {
      throw new Error('Original CUA js/js_reset and turn_ended tools are required');
    }
    if (upstreamTools.some(tool => [CONTEXT_TOOL, APPROVAL_REQUEST_TOOL, APPROVAL_CHOICE_TOOL].includes(tool.name))) {
      throw new Error('Original CUA server already uses a Claude relay host-only tool name');
    }
    const turnEndedTool = upstreamTools.find(tool => tool.name === TURN_END_TOOL);
    const contextTool = {
      name: CONTEXT_TOOL,
      description: 'Internal Claude host hook: bind the exact prompt and tool-use identity.',
      inputSchema: TURN_CONTEXT_SCHEMA,
    };

    // These cannot be hidden with deny rules like the tools above: a denied MCP tool is
    // removed from Claude Code's tool list, and the mod's `$.mcp.call` needs it listed.
    // The relay rejects any call without a mod-originated tool-use id, and the mod denies the model's.
    const approvalRequestTool = {
      name: APPROVAL_REQUEST_TOOL,
      description: 'Internal Claude host mod: describe the pending native-app approval for an elicitation message.',
      inputSchema: APPROVAL_REQUEST_SCHEMA,
    };
    const approvalChoiceTool = {
      name: APPROVAL_CHOICE_TOOL,
      description: 'Internal Claude host mod: record the person\'s choice for a pending native-app approval.',
      inputSchema: APPROVAL_CHOICE_SCHEMA,
    };

    server = new Server({ name: 'lcu-claude-relay', version: '0.1.0' }, {
      capabilities: { tools: {} },
      instructions: upstream.getInstructions() ?? '',
    });
    server.onerror = error => console.error('Claude MCP relay server error:', asError(error));
    upstream.onerror = error => console.error('Claude MCP relay upstream error:', asError(error));

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...publicTools, turnEndedTool, contextTool, approvalRequestTool, approvalChoiceTool],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: toolArgs = {}, _meta } = request.params;
      if (name === CONTEXT_TOOL) {
        const context = requireTurnContext(toolArgs);
        // Match Claude's child cleanup identity while preserving the shared prompt ID.
        if (context.agentId) context.sessionId = context.agentId;
        const previous = contexts.get(context.toolUseId);
        if (previous && (previous.sessionId !== context.sessionId || previous.turnId !== context.turnId ||
            previous.agentId !== context.agentId)) {
          throw new Error('Conflicting Claude identity for the same tool_use_id');
        }
        if (!previous && contexts.size >= 1024) {
          throw new Error('Too many pending Claude tool identities; LCU rejected this call safely');
        }
        const key = turnKey(context.sessionId, context.turnId);
        const subagent = Boolean(context.agentId);
        const crossOn = crossTurn();
        let life = lives.get(key);
        const endedLife = Boolean(life?.endedUpstream);
        // With cross-turn off, a subagent of an ended prompt shares the ended id and is refused, as before.
        const sharesEnded = subagent && !crossOn && endedPrompts.has(context.turnId);
        // A life whose id is already the closed prompt id cannot do better off-mode, so it is reused unless a
        // cleanup is in flight (the next Stop must start its own).
        const stale = endedLife && (life.cleanup || crossOn || life.upstreamId !== context.turnId);
        if (!life || stale || (sharesEnded && life.upstreamId !== context.turnId)) {
          admit(key);
          // The key's earlier life already ended upstream (completed, or a cleanup in flight that this bind
          // supersedes), so with cross-turn on this life needs a fresh upstream turn id. A random UUID, not a
          // counter, so it needs no state beyond the life record and cannot collide with a prompt id.
          const renew = crossOn && (endedLife || endedKeys.has(key));
          if (renew) log.event('turn_renew', { in_flight: Boolean(life?.cleanup), subagent });
          life = openLife(key, context.sessionId, context.turnId, subagent,
            renew ? randomUUID() : sharesEnded ? context.turnId
              : subagent ? subagentTurnId(context.sessionId, context.turnId) : context.turnId);
        }
        context.life = life;
        contexts.set(context.toolUseId, context);
        return { content: [{ type: 'text', text: 'Turn context bound.' }] };
      }
      if (MOD_ONLY_TOOLS.has(name)) {
        // Host-only: answered for the lcu-approve mod, which Claude Code marks with a plugin tool-use id.
        const modCall = _meta?.[CLAUDE_TOOL_USE_META];
        const outcome = name === APPROVAL_REQUEST_TOOL ? broker.describe(toolArgs.message, modCall)
          : broker.choose(toolArgs.id, toolArgs.choice, modCall);
        if (!outcome.ok) return { isError: true, content: [{ type: 'text', text: outcome.error }] };
        if (name === APPROVAL_REQUEST_TOOL) loggedApprovals.get(outcome.approval.id)?.claimed();
        else loggedApprovals.get(toolArgs.id)?.choice(toolArgs.choice);
        const body = outcome.approval ?? { ok: true };
        return { content: [{ type: 'text', text: JSON.stringify(body) }] };
      }
      if (name === TURN_END_TOOL) {
        const event = toolArgs.hook_event_name;
        const life = lifeForHook(toolArgs.session_id, toolArgs.turn_id, event);
        if (!life) return { content: [{ type: 'text', text: 'Turn already ended.' }] };
        return turnEnded(life, event);
      }
      if (!PUBLIC_TOOLS.has(name)) {
        return { isError: true, content: [{ type: 'text', text: `Unknown LCU tool: ${name}` }] };
      }

      const toolUseId = _meta?.[CLAUDE_TOOL_USE_META];
      const context = nonEmptyString(toolUseId) ? contexts.get(toolUseId) : undefined;
      if (!context || context.toolUseId !== toolUseId) {
        return { isError: true, content: [{ type: 'text', text:
          'Missing exact Claude PreToolUse identity; LCU did not run this tool call.' }] };
      }
      contexts.delete(toolUseId);
      // Before the metadata below, so a reset call already carries its life's fresh id.
      if (name === 'js_reset') await endWorkerTurns();
      else if (!context.life.endedUpstream) context.life.worker = worker;
      const metadata = _meta && typeof _meta === 'object' && !Array.isArray(_meta)
        ? { ..._meta } : {};
      const inheritedTurnMetadata = metadata[TURN_CONTEXT_META];
      let turnMetadata = inheritedTurnMetadata;
      if (typeof turnMetadata === 'string') {
        try { turnMetadata = JSON.parse(turnMetadata); } catch { turnMetadata = undefined; }
      }
      turnMetadata = turnMetadata && typeof turnMetadata === 'object' && !Array.isArray(turnMetadata)
        ? { ...turnMetadata } : {};
      Object.assign(turnMetadata, {
        session_id: context.sessionId,
        turn_id: context.life.upstreamId,
        call_id: toolUseId,
      });
      metadata[TURN_CONTEXT_META] = turnMetadata;
      liveCalls++;
      try {
        return await calls.track(name, { timeout_ms: toolArgs.timeout_ms, signal: extra.signal }, () =>
          callWithDeadline(approvals, callTimeout(name, toolArgs), extra.signal,
            signal => upstream.callTool({ name, arguments: toolArgs, _meta: metadata }, undefined, {
              signal,
              timeout: APPROVAL_TIMEOUT_MS,
            })));
      } finally {
        liveCalls--;
        // Never let cleanup mask the original tool result or abort error.
        if (extra.signal.aborted) {
          // The runtime's own cancel of an open elicitation is not always delivered: with no other
          // call alive, nobody is left to answer an approval the mod is still holding open.
          if (liveCalls === 0) broker.cancelWaiting();
          try {
            await turnEnded(context.life, 'Interrupt');
          } catch (error) {
            console.error('Claude MCP interrupt cleanup failed:', asError(error));
          }
        }
      }
    });

    upstream.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const params = request.params;
      const refused = declineAgentHostApp(params);
      const entry = approvalLog.open(refused ? 'agent_host_refused'
        : nativeAppApprovalOptions(params) ? 'native_app' : 'other', params);
      const response = refused ?? await answerElicitation(params, extra, entry);
      entry.end(response);
      return response;
    });

    async function answerElicitation(params, extra, entry) {
      const approval = nativeAppApprovalOptions(params);
      const pendingId = approval ? broker.open(params) : undefined;
      if (pendingId) loggedApprovals.set(pendingId, entry);
      try {
        const response = await relayElicitation(
          server, approvals, approval ? nativeForm(params, approval) : params, extra.signal);
        if (!approval) return response;
        // A claimed record means the lcu-approve mod answers for the person: the host's own answer
        // was only its hook's block, so keep this elicitation open until the mod records a choice
        // (the approval gate holds tool-call deadlines meanwhile) or the request ends.
        if (response.action !== 'accept' && broker.isClaimed(pendingId)) {
          const waited = await approvals.track(() => broker.awaitChoice(pendingId, extra.signal));
          return waited ? nativeAppApprovalResponse(params, waited) : { action: 'cancel' };
        }
        // A choice the lcu-approve mod recorded for this exact request answers for the person.
        const modChoice = broker.settle(pendingId);
        if (modChoice) return nativeAppApprovalResponse(params, modChoice);
        if (response.action !== 'accept') return nativeAppApprovalResponse(params, response.action);
        return nativeAppApprovalResponse(params, response.content?.choice);
      } catch {
        return { action: 'cancel' };
      } finally {
        if (pendingId) {
          broker.settle(pendingId);
          loggedApprovals.delete(pendingId);
        }
      }
    }

    const closeUpstreamAfterTurnCleanup = () => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        const drain = (async () => {
          for (const life of [...lives.values()]) {
            try {
              await turnEnded(life, 'Interrupt');
            } catch (error) {
              console.error('Claude MCP turn cleanup during shutdown failed:', asError(error));
            }
          }
        })();
        // Cleanups of superseded lives are still in flight too; give them the same drain window.
        // Requests submitted while draining (serial cascades) join the wait until none is left.
        const drainAll = (async () => {
          await drain;
          while (pendingEnds.size) await Promise.allSettled([...pendingEnds]);
        })();
        let timer;
        const drained = await Promise.race([drainAll.then(() => true), new Promise(resolve => {
          timer = setTimeout(resolve, shutdownDrainMs, false);
        })]);
        clearTimeout(timer);
        if (!drained) {
          console.error(`Claude MCP turn cleanup during shutdown did not finish within ${shutdownDrainMs} ms; ` +
            'closing the original server');
          log.event('shutdown_drain', { ms: shutdownDrainMs, outcome: 'timeout' });
        }
        if (connected) {
          connected = false;
          try {
            await upstream.close();
          } catch (error) {
            console.error('Claude MCP upstream close failed:', asError(error));
          }
          log.event('upstream_close');
        }
      })();
      return shutdown;
    };
    server.onclose = () => { void closeUpstreamAfterTurnCleanup(); };
    const transport = new StdioServerTransport();
    const closeDownstream = () => {
      // The host is gone. Closing the server aborts its in-flight calls, which cancels them upstream and
      // starts their Interrupt cleanup, and its onclose drains the remaining turns before closing upstream.
      // Draining first would wait for each in-flight call to end on its own.
      if (!serverClose) serverClose = server.close().catch(error => {
        console.error('Claude MCP relay close failed:', asError(error));
      });
      void closeUpstreamAfterTurnCleanup();
    };
    await server.connect(transport);
    // The SDK's stdio server transport owns MCP framing but does not surface stdin EOF.
    // EOF is the actual Claude-side connection-close signal; use it to drain exact
    // active turns before closing the original MCP client.
    process.stdin.once('end', closeDownstream);
    return { server, upstream, contexts, activeTurns: lives, close: async () => {
      process.stdin.off('end', closeDownstream);
      await closeUpstreamAfterTurnCleanup();
      if (!serverClose) serverClose = server.close();
      await serverClose;
    } };
  } catch (error) {
    if (connected) await upstream.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: claude.mjs ORIGINAL_MCP_COMMAND [ARG ...]');
  await runClaudeBridge({ command, args });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error('Claude MCP relay failed:', asError(error));
    process.exitCode = 1;
  });
}
