# Codex MCP progress relay verification

The Codex relay now routes progress through the official MCP SDK's public notification-handler API instead of the SDK's `onprogress` callback. It assigns an opaque per-call upstream `progressToken`, maps it to the caller's downstream token, and removes the mapping when the tool call settles. Notifications arriving after settlement are ignored. The relay waits for any accepted downstream progress writes before returning a result or error.

This works around an upstream TypeScript SDK race. The locked dependency is `@modelcontextprotocol/sdk` 1.30.0. Its v1 `Protocol._onnotification` schedules registered notification handlers in a promise microtask, while `Protocol._onresponse` deletes the progress callback immediately. When a progress notification and tool result are read back-to-back, the result can delete the callback before `_onprogress` executes. The SDK reports the otherwise valid frame as an unknown token. The upstream project tracks this exact behavior in [issue #2580](https://github.com/modelcontextprotocol/typescript-sdk/issues/2580). The SDK's [server progress guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md#progress) documents the token-based notification contract.

The relay fix uses only public SDK APIs: `setNotificationHandler(ProgressNotificationSchema, ...)`, `Client.callTool(params, resultSchema, options)`, and the request's `_meta.progressToken`. It does not pass `onprogress` in the `Client.callTool` options or patch SDK internals or implement MCP framing. The custom handler retains per-call routing state through the response-microtask race; downstream sends are drained on both success and failure so the final response cannot overtake an accepted progress frame.

`adapters/test/codex.test.mjs` exercises an adjacent upstream progress/result pair and injects delay at the relay's outgoing stdio write. It records parsed wire frames and asserts the progress notification precedes the matching success result and error response. It does not assert `Client.callTool`'s `onprogress` callback: SDK 1.x itself can drop a correctly ordered notification at that callback boundary, as described in issue #2580.

Verification in the disposable `lcu-verification:arm64` image, with Docker networking disabled:

```sh
docker run --rm --network none --platform linux/arm64 \
  -v "$PWD:/src:ro" -w /src/adapters lcu-verification:arm64 \
  node --test test/codex.test.mjs

docker run --rm --network none --platform linux/arm64 \
  -v "$PWD:/src:ro" -w /src/adapters lcu-verification:arm64 \
  node --test 'test/*.test.mjs'
```

The focused suite passed (2 tests). The adapter suite passed (35 tests, 8 environment-dependent skips).
