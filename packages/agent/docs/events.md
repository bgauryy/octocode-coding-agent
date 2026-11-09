# Events and hooks

Part of the [`@octocodeai/octocode-agent-core`](../README.md) guide. Options and methods: [API](api.md).

## Sequence

```mermaid
sequenceDiagram
  participant A as Agent
  participant M as Model
  participant T as Tools
  A->>A: agent_start, turn_start
  A->>A: message_start/end (user prompt)
  A->>M: prepareRequest, then request
  M-->>A: message_start, message_update…, message_end (assistant)
  opt assistant called tools
    A->>T: tool_execution_start → beforeToolCall → execute
    T-->>A: tool_execution_update… → afterToolCall → tool_execution_end
    A->>A: message_start/end (toolResult)
  end
  A->>A: finishTurn, turn_end { message, toolResults }
  Note over A: tool results, steering or follow-up start another turn; otherwise agent_end
```

| Event                                       | Meaning                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_start` / `agent_end`                 | Run boundaries. `agent_end` is the last loop event; `waitForIdle()` and `prompt()` settle only after awaited `agent_end` listeners finish |
| `turn_start` / `turn_end`                   | One provider call plus its tool executions; `turn_end` carries the assistant message and tool results                                     |
| `message_start` / `message_end`             | Any message (user, assistant, toolResult) begins or completes                                                                             |
| `message_update`                            | Assistant only; `assistantMessageEvent` holds the delta                                                                                   |
| `tool_execution_start` / `_update` / `_end` | Tool begins, streams progress, completes                                                                                                  |

`Agent` treats assistant `message_end` handling as a barrier before tool preflight, so `beforeToolCall` sees state that already includes the assistant message.

## Tool execution hooks

| Setting                               | Behavior                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `toolExecution: "parallel"` (default) | Preflight calls in order, run allowed tools concurrently. `tool_execution_end` follows completion order; toolResult messages and `turn_end.toolResults` follow assistant source order                                                                              |
| `toolExecution: "sequential"`         | One call at a time                                                                                                                                                                                                                                                 |
| `executionMode` on an `AgentTool`     | One `"sequential"` tool makes the whole batch sequential                                                                                                                                                                                                           |
| `beforeToolCall`                      | Runs after `tool_execution_start` and argument validation. Can block and attach `terminate: true`. Return `revalidate` (async, returns `{ block, reason }` or nothing) to re-check right before that call runs, since in a parallel batch an approval can go stale |
| `afterToolCall`                       | Runs after execution, before `tool_execution_end` and the result message. Can replace `content`, `details`, `structuredContent`, `isError`, `usage`, `terminate`; omitted fields keep their values, no deep merge                                                  |
| `unknownToolMessage(name)`            | A call to an undeclared tool skips the hooks and gets `Tool <name> not found`; this field replaces the text (return `undefined` for the default)                                                                                                                   |
| `pendingToolNames()`                  | Tools declared but not executable yet (for example a server still connecting) are not declared removed while absent from `tools`                                                                                                                                   |
| `terminate: true`                     | Skips the follow-up LLM call only when every finalized result in the batch sets it; mixed batches continue                                                                                                                                                         |

## Request preparation and turn finalization

`prepareRequest` runs before every provider request, including the first, to install canonical persisted context. It does not poll queues; steering queued meanwhile waits for the next poll. A wrapped hook can run twice for one request when a virtual model's routing triggers an automatic compaction in between, so keep it free of side effects that cannot repeat.

```typescript
agent.prepareRequest = async ({ context }) => ({
	context: { ...context, messages: await session.loadModelContext() },
});
```

`finishTurn` runs after the assistant and all tool results are final, before `turn_end`, for normal, error and aborted responses.

| Return                   | Effect                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `undefined`              | Normal scheduling                                                                                                                           |
| `{ action: "end" }`      | Stop right after `turn_end`, without polling queues or preparing a request                                                                  |
| `{ action: "continue" }` | Ensure one next request (tool results, steering or follow-up already satisfy it; otherwise one context-only request). Normal responses only |

Error and aborted responses are hard exits: decisions are ignored, so guard them when the predicate has side effects. `finishTurn` runs again after the next request; returning `continue` unconditionally loops forever. `{ action: "end" }` replaces the removed `shouldStopAfterTurn`.

```typescript
agent.finishTurn = async ({ message }) => {
	if (message.stopReason === "error" || message.stopReason === "aborted") return;
	return shouldEndRun(message) ? { action: "end" } : undefined;
};
```

## continue() and queued input

An empty or system-only transcript rejects without consuming queues. A non-assistant tail continues from existing context: steering is polled at startup, follow-up waits until the response stops. An assistant tail cannot be sent, so `continue()` falls back to one queued steering batch, then one follow-up batch; queue mode decides whether the batch is one message or all.

```typescript
agent.followUp({ role: "user", content: "After the retry", timestamp: Date.now() });
await agent.continue(); // retries the existing user/toolResult tail
```
