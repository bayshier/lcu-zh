// Scripted Anthropic Messages API for Claude Code CLI tests. No credentials, no model.
// Usage: node claude_fake_api.mjs PORT_FILE LOG_FILE TOOL_NAME TOOL_INPUT_JSON
// The first request that offers TOOL_NAME and carries no tool_result answers with one call
// to it; every other request answers with short text, so title and summary calls succeed.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [portFile, logFile, toolName, toolInput = '{}'] = process.argv.slice(2);
let calls = 0;

function sse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

function message(model) {
  return { type: 'message_start', message: { id: `msg_fake${calls}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
}

function textReply(response, model, text) {
  sse(response, [
    ['message_start', message(model)],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function toolReply(response, model) {
  sse(response, [
    ['message_start', message(model)],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_01FAKE${calls}`, name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolInput } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    if (!request.url.startsWith('/v1/messages')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    calls += 1;
    const offered = (parsed.tools ?? []).some(tool => tool.name === toolName);
    const hasResult = JSON.stringify(parsed.messages ?? []).includes('"tool_result"');
    const isMain = offered && !JSON.stringify(parsed.messages ?? []).includes('Generate a title');
    const results = [];
    for (const message of parsed.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === 'tool_result') results.push(JSON.stringify(block.content));
      }
    }
    appendFileSync(logFile, `${JSON.stringify({ n: calls, url: request.url, model: parsed.model, offered, hasResult, results })}\n`);
    if (isMain && !hasResult) return toolReply(response, parsed.model ?? 'claude-sonnet-4-5');
    return textReply(response, parsed.model ?? 'claude-sonnet-4-5', hasResult ? 'The tool finished.' : 'ok');
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
