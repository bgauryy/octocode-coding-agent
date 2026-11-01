# Steering, messages and tools

Part of the [`@octocodeai/octocode-agent-core` guide](../README.md).

## Steering and Follow-up

Steering messages let you interrupt the agent while tools are running. Follow-up messages let you queue work after the agent would otherwise stop.

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// While agent is running tools
agent.steer({
	role: "user",
	content: "Stop! Do this instead.",
	timestamp: Date.now(),
});

// After the agent finishes its current work
agent.followUp({
	role: "user",
	content: "Also summarize the result.",
	timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

Use clearSteeringQueue, clearFollowUpQueue, or clearAllQueues to drop queued messages. To change one queued message without touching the others, use `hasQueuedMessage(message)`, `removeQueuedMessage(message)`, `swapQueuedMessages(first, second)` (same queue only) and `placeQueuedMessage(message, "steer" | "followUp", before?)`, which takes the message out of either queue and queues it in the named one, before `before` when that message is queued there, otherwise last. The same message object is the handle for all of them.

When steering messages are detected after a turn completes:

1. All tool calls from the current assistant message have already finished
2. Steering messages are injected
3. The LLM responds on the next turn

Follow-up messages are checked only when there are no more tool calls and no steering messages. If any are queued, they are injected and another turn runs.

## Custom Message Types

Extend `AgentMessage` via declaration merging:

```typescript
declare module "@octocodeai/octocode-agent-core" {
	interface CustomAgentMessages {
		notification: { role: "notification"; text: string; timestamp: number };
	}
}

// Now valid
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

Handle custom types in `convertToLlm`:

```typescript
const agent = new Agent({
	streamFn: models.streamSimple.bind(models),
	convertToLlm: (messages) =>
		messages.flatMap((m) => {
			if (m.role === "notification") return []; // Filter out
			return [m];
		}),
});
```

## Tools

Define tools using `AgentTool`:

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
	name: "read_file",
	label: "Read File", // For UI display
	description: "Read a file's contents",
	parameters: Type.Object({
		path: Type.String({ description: "File path" }),
	}),
	// Override execution mode for this tool (optional).
	// "sequential" forces the entire batch to run one at a time.
	// "parallel" allows concurrent execution with other tool calls.
	// If omitted, the global toolExecution config applies.
	executionMode: "sequential",
	execute: async (toolCallId, params, signal, onUpdate) => {
		const content = await fs.readFile(params.path, "utf-8");

		// Optional: stream progress
		onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

		// Optional: add `terminate: true` here to skip the automatic follow-up LLM call
		// when every finalized tool result in the batch does the same.
		return {
			content: [{ type: "text", text: content }],
			details: { path: params.path, size: content.length },
		};
	},
};

agent.state.tools = [readFileTool];
```

### Error Handling

**Throw an error** when a tool fails. Do not return error messages as content.

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
	if (!fs.existsSync(params.path)) {
		throw new Error(`File not found: ${params.path}`);
	}
	// Return content only on success
	return { content: [{ type: "text", text: "..." }] };
};
```

Thrown errors are caught by the agent and reported to the LLM as tool errors with `isError: true`.

Return `terminate: true` from `execute()`, a blocked `beforeToolCall`, or `afterToolCall` to hint that the agent should stop after the current tool batch. This only takes effect when every finalized tool result in the batch is terminating. The hint is runtime-only; emitted `toolResult` transcript messages remain standard LLM tool results.

### MCP tools

`@octocodeai/octocodecode/mcp` connects to MCP servers. Hosts adapt each server tool to an `AgentTool` and execute it through `runToolCall()`, preserving `beforeToolCall` and `afterToolCall` hooks.
