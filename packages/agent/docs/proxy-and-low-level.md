# Proxy and low-level API

Part of the [`@octocodeai/octocode-agent-core` guide](../README.md).

## Proxy Usage

For browser apps that proxy through a backend:

Proxy servers send `content_update` with `{ contentIndex, content }`, where `content` is the complete normalized assistant block. This retains attachments and source annotations after stripping the provider event's `partial` field. A `text_end` frame can also carry authoritative `text` and `annotations` alongside `contentSignature`.

```typescript
import { Agent, streamProxy } from "@octocodeai/octocode-agent-core";

const agent = new Agent({
	streamFn: (model, context, options) =>
		streamProxy(model, context, {
			...options,
			authToken: "...",
			proxyUrl: "https://your-server.com",
		}),
});
```

## Low-Level API

Tool results may provide `structuredContent` independently of model-facing `content`. The agent retains it in the persisted `ToolResultMessage` for replay and interface consumers; it is not sent to the model as an additional payload.

For direct control without the Agent class:

```typescript
import { agentLoop, agentLoopContinue } from "@octocodeai/octocode-agent-core";

const context: AgentContext = {
	messages: [{ role: "system", content: "You are helpful.", timestamp: Date.now() }],
	tools: [],
};

const config: AgentLoopConfig = {
	model: getBuiltinModel("openai", "gpt-4o"),
	convertToLlm: (msgs) => msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)),
	toolExecution: "parallel", // overridden by per-tool executionMode if set
	beforeToolCall: async ({ toolCall, args, context }) => undefined,
	afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
	console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
	console.log(event.type);
}
```

These low-level streams are observational. They preserve event order, but they do not wait for your async event handling to settle before later producer phases continue. If you need message processing to act as a barrier before tool preflight, use the `Agent` class instead of raw `agentLoop()` or `agentLoopContinue()`.
