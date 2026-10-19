import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
  ProgressNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { persistAudioContent } from './audio-files.mjs';
import {
  APPROVAL_TIMEOUT_MS,
  callTimeout,
  callWithDeadline,
  createApprovalGate,
  createApprovalLogger,
  createCallTracker,
  createWorkerTurns,
  isMainModule,
  nativeAppApprovalOptions,
  relayElicitation,
  TURN_END_TIMEOUT_MS,
} from './client.mjs';
import { openDiagnosticLog } from './diagnostics.mjs';
import { declineAgentHostApp } from './host-guard.mjs';

const HOST_ONLY_TOOLS = new Set(['js_add_node_module_dir', 'turn_ended']);
const TURN_CONTEXT_META = 'x-codex-turn-metadata';

function report(label, error) {
  console.error(`${label}:`, error instanceof Error ? error.message : String(error));
}

/** The call's Codex turn metadata as an object (it may arrive as JSON text), or undefined. */
function turnMetadataOf(params) {
  let metadata = params._meta?.[TURN_CONTEXT_META];
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { return undefined; }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      typeof metadata.session_id !== 'string' || !metadata.session_id ||
      typeof metadata.turn_id !== 'string' || !metadata.turn_id) return undefined;
  return metadata;
}

/** Relay the original Codex CUA MCP server and replace only returned audio blocks. */
export async function runCodexBridge({ command, args = [], cwd, env, log = openDiagnosticLog({ adapter: 'codex' }) } = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
      args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Codex bridge requires the original MCP command and string arguments');
  }

  const upstreamTransport = new StdioClientTransport({
    command,
    args,
    ...(cwd ? { cwd } : {}),
    env: env ?? process.env,
    stderr: 'inherit',
  });
  const upstream = new Client({ name: 'lcu-codex-relay', version: '0.1.0' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  let server;
  let connected = false;
  let shutdown;
  let nextProgressToken = 0;
  const approvals = createApprovalGate();
  const calls = createCallTracker(log);
  const approvalLog = createApprovalLogger(log, calls);
  const progressHandlers = new Map();
  const workerTurns = createWorkerTurns();

  // Upstream ids differ from Codex's only for a turn that continued after js_reset (see createWorkerTurns).
  async function withUpstreamTurn(params) {
    if (params.name === 'turn_ended') {
      const { session_id: sessionId, turn_id: turnId } = params.arguments ?? {};
      if (typeof sessionId !== 'string' || typeof turnId !== 'string') return params;
      const upstreamId = workerTurns.upstreamId(sessionId, turnId);
      return upstreamId === turnId ? params : { ...params, arguments: { ...params.arguments, turn_id: upstreamId } };
    }
    const metadata = turnMetadataOf(params);
    if (!metadata) return params;
    const { session_id: sessionId, turn_id: turnId } = metadata;
    if (params.name === 'js_reset') {
      await workerTurns.reset((session, upstreamId) => endTurn(session, upstreamId, 'Interrupt',
        { cause: 'js_reset', sky_hook: 'live' }));
    } else if (params.name === 'js') workerTurns.ranJs(sessionId, turnId);
    const upstreamId = workerTurns.upstreamId(sessionId, turnId);
    if (upstreamId === turnId) return params;
    const renewed = { ...metadata, turn_id: upstreamId };
    const original = params._meta[TURN_CONTEXT_META];
    return { ...params, _meta: { ...params._meta,
      [TURN_CONTEXT_META]: typeof original === 'string' ? JSON.stringify(renewed) : renewed } };
  }

  // Codex's own lifecycle hook, logged like the other relays' turn ends.
  async function hookTurnEnded({ hook_event_name: event, session_id: sessionId, turn_id: turnId } = {}, run) {
    const skyHook = workerTurns.skyHook(sessionId, turnId);
    const started = Date.now();
    let outcome = 'error';
    try {
      const result = await run();
      if (!result.isError) {
        outcome = 'ok';
        workerTurns.ended(sessionId, turnId);
      }
      return result;
    } finally {
      log.event('turn_end', { hook_event: event, ms: Date.now() - started, outcome, sky_hook: skyHook });
    }
  }

  async function endTurn(sessionId, upstreamId, event, fields) {
    const started = Date.now();
    let outcome = 'error';
    try {
      const result = await upstream.callTool({ name: 'turn_ended', arguments: {
        hook_event_name: event, session_id: sessionId, turn_id: upstreamId,
      } }, undefined, { timeout: TURN_END_TIMEOUT_MS });
      if (!result.isError) outcome = 'ok';
      return result;
    } finally {
      log.event('turn_end', { hook_event: event, ...fields, ms: Date.now() - started, outcome });
    }
  }

  upstream.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const refused = declineAgentHostApp(request.params);
    const entry = approvalLog.open(refused ? 'agent_host_refused'
      : nativeAppApprovalOptions(request.params) ? 'native_app' : 'other', request.params);
    let response = refused;
    if (!response) {
      try {
        response = await relayElicitation(server, approvals, request.params, extra.signal);
      } catch {
        response = { action: 'cancel' };
      }
    }
    entry.end(response);
    return response;
  });

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
    // SDK 1.x removes a request's progress callback as soon as its response is
    // parsed, while notification handlers run in a later microtask. A progress
    // frame adjacent to its result can therefore be rejected as an unknown
    // token. Route progress through the public notification-handler API and
    // keep our own per-call token until the tool call settles; late frames are
    // benign and ignored.
    upstream.setNotificationHandler(ProgressNotificationSchema, async notification => {
      const { progressToken, ...progress } = notification.params;
      const handler = progressHandlers.get(progressToken);
      if (handler) await handler(progress);
    });
    const originalCapabilities = upstream.getServerCapabilities() ?? {};
    if (!originalCapabilities.tools) {
      throw new Error('Original CUA server does not advertise tools');
    }
    const capabilities = {
      tools: originalCapabilities.tools.listChanged ? { listChanged: true } : {},
    };
    const serverOptions = { capabilities };
    const instructions = upstream.getInstructions();
    if (instructions !== undefined) serverOptions.instructions = instructions;
    server = new Server(upstream.getServerVersion() ?? { name: 'lcu-codex-relay', version: '0.1.0' }, serverOptions);
    server.onerror = error => report('Codex MCP relay server error', error);
    upstream.onerror = error => report('Codex MCP relay upstream error', error);

    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const listed = await upstream.listTools(request.params, { signal: extra.signal });
      return { ...listed, tools: listed.tools.filter(tool => !HOST_ONLY_TOOLS.has(tool.name)) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { params } = request;
      const progressSends = [];
      let upstreamParams = await withUpstreamTurn(params);
      const downstreamProgressToken = extra._meta?.progressToken;
      let upstreamProgressToken;
      if (downstreamProgressToken !== undefined) {
        upstreamProgressToken = `lcu-codex-${++nextProgressToken}`;
        upstreamParams = {
          ...upstreamParams,
          _meta: { ...upstreamParams._meta, progressToken: upstreamProgressToken },
        };
        progressHandlers.set(upstreamProgressToken, progress => {
          const send = extra.sendNotification({
            method: 'notifications/progress',
            params: { ...progress, progressToken: downstreamProgressToken },
          }).catch(error => report('Codex MCP progress relay error', error));
          progressSends.push(send);
          return send;
        });
      }
      try {
        const callUpstream = () => callWithDeadline(approvals, callTimeout(params.name, params.arguments),
          extra.signal, signal => upstream.callTool(upstreamParams, undefined, {
            signal,
            timeout: APPROVAL_TIMEOUT_MS,
          }));
        const result = params.name === 'turn_ended' ? await hookTurnEnded(params.arguments, callUpstream)
          : HOST_ONLY_TOOLS.has(params.name) ? await callUpstream()
            : await calls.track(params.name, { timeout_ms: params.arguments?.timeout_ms, signal: extra.signal }, callUpstream);
        return persistAudioContent(result);
      } finally {
        if (upstreamProgressToken !== undefined) progressHandlers.delete(upstreamProgressToken);
        // Drain notifications on both success and failure so neither a result
        // nor an error can overtake progress already accepted for this call.
        await Promise.all(progressSends);
      }
    });

    if (originalCapabilities.tools.listChanged) {
      upstream.setNotificationHandler(ToolListChangedNotificationSchema, async notification => {
        await server.notification(notification);
      });
    }

    const closeUpstream = () => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        if (connected) {
          connected = false;
          try {
            await upstream.close();
          } catch (error) {
            report('Codex MCP upstream close failed', error);
          }
          log.event('upstream_close');
        }
      })();
      return shutdown;
    };
    server.onclose = () => { void closeUpstream(); };
    let serverClose;
    upstream.onclose = () => {
      if (server && server.transport) {
        if (!serverClose) serverClose = server.close().catch(error => {
          report('Codex MCP relay close failed', error);
        });
      }
    };
    const closeDownstream = () => {
      if (!serverClose) serverClose = server.close().catch(error => {
        report('Codex MCP relay close failed', error);
      });
      return serverClose;
    };
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // The SDK stdio server does not report stdin EOF through onclose.
    process.stdin.once('end', closeDownstream);
    return {
      server,
      upstream,
      close: async () => {
        process.stdin.off('end', closeDownstream);
        await closeDownstream();
        await closeUpstream();
      },
    };
  } catch (error) {
    if (connected) await upstream.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: codex.mjs ORIGINAL_MCP_COMMAND [ARG ...]');
  await runCodexBridge({ command, args });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    report('Codex MCP relay failed', error);
    process.exitCode = 1;
  });
}
