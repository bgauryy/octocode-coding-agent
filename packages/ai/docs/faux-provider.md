# Faux Provider for Tests

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

`fauxProvider()` builds an in-memory provider with scripted responses for tests and demos:

```typescript
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@octocodeai/octocode-ai";

const faux = fauxProvider({
	tokensPerSecond: 50, // optional
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
	messages: [{ role: "user", content: "Summarize package.json and then call echo", timestamp: Date.now() }],
};

faux.setResponses([
	fauxAssistantMessage(
		[fauxThinking("Need to inspect package metadata first."), fauxToolCall("echo", { text: "package.json" })],
		{ stopReason: "toolUse" },
	),
]);

const first = await models.complete(model, context, {
	sessionId: "session-1",
	cacheRetention: "short",
});
context.messages.push(first);

context.messages.push({
	role: "toolResult",
	toolCallId: first.content.find((block) => block.type === "toolCall")!.id,
	toolName: "echo",
	content: [{ type: "text", text: "package.json contents here" }],
	isError: false,
	timestamp: Date.now(),
});

faux.setResponses([
	fauxAssistantMessage([fauxThinking("Now I can summarize the tool output."), fauxText("Here is the summary.")]),
]);

const s = models.stream(model, context);
for await (const event of s) {
	console.log(event.type);
}

// Optional: multiple faux models for model-switching tests
const multiModel = fauxProvider({
	provider: "faux-multi",
	models: [
		{ id: "faux-fast", reasoning: false },
		{ id: "faux-thinker", reasoning: true },
	],
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel("faux-thinker");

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

Notes:

- Responses are consumed from a queue in request start order.
- If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.
- Use `faux.setResponses([...])` to replace the remaining queue and `faux.appendResponses([...])` to add more responses.
- `faux.models` exposes all faux models. `faux.getModel()` returns the first one, and `faux.getModel(id)` returns a specific one.
- Use `fauxAssistantMessage(...)` for scripted assistant replies. Use `fauxText(...)`, `fauxThinking(...)`, and `fauxToolCall(...)` to build content blocks without filling in low-level fields manually.
- Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.
- Tool call arguments stream incrementally via `toolcall_delta` chunks.
- By default, each streamed chunk is emitted on its own microtask. Set `tokensPerSecond` to pace chunk delivery in real time.
- The intended use is one deterministic scripted flow per handle. If you need independent concurrent flows, create separate faux providers with distinct `provider` ids.
