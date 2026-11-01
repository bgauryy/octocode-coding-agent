# Event Flow

Part of the [`@octocodeai/octocode-agent-core` guide](../README.md).

The agent emits events for UI updates. Understanding the event sequence helps build responsive interfaces.

## prompt() Event Sequence

When you call `prompt("Hello")`:

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

## With Tool Calls

If the assistant calls tools, the loop continues:

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // If tool streams
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // Next turn
├─ message_start      { assistantMessage }           // LLM responds to tool result
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

Tool execution mode is configurable:

- `parallel` (default): preflight tool calls sequentially, execute allowed tools concurrently, emit `tool_execution_end` as soon as each tool is finalized, then emit toolResult messages and `turn_end.toolResults` in assistant source order
- `sequential`: execute tool calls one by one, matching the historical behavior

In parallel mode, tool completion events follow tool completion order, but persisted toolResult messages still follow assistant source order.

The mode can be set globally via `toolExecution` in the agent config, or per-tool via `executionMode` on `AgentTool`. If any tool call in a batch targets a tool with `executionMode: "sequential"`, the entire batch executes sequentially regardless of the global setting.

The `beforeToolCall` hook runs after `tool_execution_start` and validated argument parsing. It can block execution and attach `terminate: true` to the blocked result. In a parallel batch every call is prepared before any runs, so an approval can go stale while later calls wait; return `revalidate` (an async function returning `{ block, reason }` or nothing) to check again right before that call executes. The `afterToolCall` hook runs after tool execution finishes and before `tool_execution_end` and final tool result message events are emitted.

A call to a tool the request did not declare never reaches the hooks; it gets the error `Tool <name> not found`. Set `unknownToolMessage(name)` (an `Agent` field, constructor option or loop config) to return a different error text, for example how to load the tool; return `undefined` to keep the default.

Tools the host has declared but cannot execute yet, such as tools of a server that is still connecting, can be named by `pendingToolNames()` (an `Agent` field, constructor option or `AgentContext` field). The loop does not declare them removed while they are absent from `tools`; when the host drops the name they are declared removed as usual.

Tools, blocked `beforeToolCall` results, and `afterToolCall` overrides can return `terminate: true` to hint that the automatic follow-up LLM call should be skipped. The loop only stops early when every finalized tool result in that batch sets `terminate: true`. Mixed batches continue normally.

Throw `AgentToolExecutionError(message, result)` when a rejected tool execution must retain structured `details` or output. The loop preserves that result and marks it as an error. Ordinary exceptions expose their message with empty details.

When you use the `Agent` class, assistant `message_end` processing is treated as a barrier before tool preflight begins. That means `beforeToolCall` sees agent state that already includes the assistant message that requested the tool call.

## Request preparation and turn finalization

`prepareRequest` runs immediately before every conversational provider request, including the first. Use it to install canonical persisted context after pending input has been emitted:

```typescript
agent.prepareRequest = async ({ context }) => ({
	context: { ...context, messages: await session.loadModelContext() },
});
```

`prepareRequest` does not poll queues. Steering queued while it runs waits for the next normal steering poll. A hook that `AgentSession` wraps can run twice for one request, when a virtual model's routing triggers an automatic compaction between the two; keep it free of side effects that cannot repeat.

`finishTurn` runs after the assistant and all tool results are finalized, but before `turn_end`. It runs for normal, error, and aborted responses:

```typescript
agent.finishTurn = async ({ message }) => {
	if (message.stopReason === "error" || message.stopReason === "aborted") return;
	if (shouldEndRun(message)) return { action: "end" };
	return needsAnotherResponse(message) ? { action: "continue" } : undefined;
};
```

Returning `undefined` preserves normal scheduling. `{ action: "end" }` stops immediately after `turn_end`, before polling steering or follow-up queues or preparing another request. On a normal response, `{ action: "continue" }` ensures one next provider request. If tool results, steering, or a follow-up already cause that request, they satisfy the decision and no additional request is made; otherwise the loop makes one context-only request. Error and aborted responses remain hard exits, so their decisions are ignored. `finishTurn` runs again after the next request, so returning `{ action: "continue" }` unconditionally creates an endless loop.

To migrate from the removed `shouldStopAfterTurn`, return `{ action: "end" }`. Guard error and aborted responses to preserve the old hook's normal-response-only invocation, especially when the predicate has side effects or assumes a successful response:

```typescript
finishTurn: async (turn, signal) => {
  if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
  return (await shouldStop(turn, signal)) ? { action: "end" } : undefined;
},
```

Each provider turn follows this lifecycle:

```text
selected input events
→ prepareRequest
→ provider response
→ tool results
→ finishTurn
→ turn_end
→ existing continuation scheduling or agent_end
```

## continue() and queued input

`continue()` retains its existing queue behavior. Empty and system-only transcripts reject without consuming queues. A non-assistant tail continues from existing context: steering is polled at startup, while follow-up input waits until the response naturally stops.

```typescript
agent.followUp({ role: "user", content: "After the retry", timestamp: Date.now() });
await agent.continue(); // The first request retries the existing user/toolResult tail.
```

An assistant tail cannot be sent directly, so `continue()` falls back to one queued steering batch, then one queued follow-up batch. Queue mode still controls whether that selected batch contains one message or all messages:

```typescript
agent.steer({ role: "user", content: "Continue from here", timestamp: Date.now() });
await agent.continue(); // Uses the queued message only because the tail is assistant.
```

## Event Types

| Event                   | Description                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `agent_start`           | Agent begins processing                                                                   |
| `agent_end`             | Final event for the run. Awaited subscribers for this event still count toward settlement |
| `turn_start`            | New turn begins (one LLM call + tool executions)                                          |
| `turn_end`              | Turn completes with assistant message and tool results                                    |
| `message_start`         | Any message begins (user, assistant, toolResult)                                          |
| `message_update`        | **Assistant only.** Includes `assistantMessageEvent` with delta                           |
| `message_end`           | Message completes                                                                         |
| `tool_execution_start`  | Tool begins                                                                               |
| `tool_execution_update` | Tool streams progress                                                                     |
| `tool_execution_end`    | Tool completes                                                                            |

`Agent.subscribe()` listeners are awaited in registration order. `agent_end` means no more loop events will be emitted, but `await agent.waitForIdle()` and `await agent.prompt(...)` only settle after awaited `agent_end` listeners finish.
