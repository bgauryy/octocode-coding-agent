# Errors and observability

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

## Telemetry

Pass an explicit parent span (`TelemetrySpan`, not an adapter) through `telemetry`; omitting it uses the no-op span:

```typescript
import { InMemoryTelemetryContext } from "@octocodeai/octocode-telemetry";

const telemetry = new InMemoryTelemetryContext();
await telemetry.startSpan({ name: "application.turn" }, async (span) => {
	await models.completeSimple(model, context, { telemetry: span });
});
```

`Models.stream()` and `streamSimple()` create `octocode.ai.request`; `streamDeferred()` creates one `octocode.ai.poll` per poll. Their completion helpers use the same spans. These spans include auth/setup, end at the terminal result, and do not require the caller to consume events. Direct provider/API calls are not instrumented.

`AI_TELEMETRY_SCHEMA`, exported from the root and `@octocodeai/octocode-ai/models`, defines the typed vocabulary:

- Start attributes: `provider`, `api`, `model`, and `reasoning` only when `options.reasoning` is a string. Provider-native reasoning objects are ignored.
- End attributes: `stop`, `usage.input`, `usage.output`, `usage.cache_read`, `usage.cache_write`, `cost.total`, and optional `response.id`. `stop: "error"` sets error status with the fixed category `provider_error` and `AssistantMessage.errorMessage` truncated to 500 characters (empty when absent). Cancellation keeps status `ok` with `stop: "aborted"`.
- `octocode.ai.first_chunk` marks the first normalized event, including setup errors. Each completed text, thinking, or tool-call block emits `octocode.ai.block` with `type`, `index`, and `chars`; only tool calls include `tool`. Character counts use JavaScript string length; tool counts sum argument delta lengths without serializing arguments.

When `options.telemetry.metrics` is available, the same requests record metrics:

| Metric                             | Unit    | Attributes                                                                   |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `octocode.ai.request.duration`     | `ms`    | `provider`, `model`, `stop`                                                  |
| `octocode.ai.first_chunk.duration` | `ms`    | `provider`, `model`                                                          |
| `octocode.ai.tokens`               | `token` | `provider`, `model`, `kind` (`input`, `output`, `cache_read`, `cache_write`) |
| `octocode.ai.cost`                 | `USD`   | `provider`, `model`                                                          |

Durations use `performance.now()`. Pending/deferred polls do not add tokens or cost; final completed/error polls do. A parent span without metric capabilities remains valid and simply records no metrics. Adapter-created spans carry the same optional metric and propagation capabilities as their root.

Telemetry does not record prompts, generated text, reasoning content, or arguments in attributes/events. Error status includes up to 500 characters of provider error text, which may contain sensitive data; apply your export policy accordingly. Telemetry observes the existing forwarding path without another stream consumer or per-delta events. Response identifiers and error messages never become metric attributes.

## Error Handling

Request failures after a stream is returned never throw: when a request ends with an error (including aborts and tool call validation errors), the streaming API emits an error event and the final message carries the details. Setup failures may emit `error` without `start`; failures after generation begins emit `start`, any observed updates, then `error`. Direct API `streamSimple()` calls throw synchronously when request auth is missing:

```typescript
// In streaming
for await (const event of s) {
	if (event.type === "error") {
		// event.reason is either "error" or "aborted"
		// event.error is the AssistantMessage with partial content
		console.error(`Error (${event.reason}):`, event.error.errorMessage);
		console.log("Partial content:", event.error.content);
	}
}

// The final message will have the error details
const message = await s.result();
if (message.stopReason === "error" || message.stopReason === "aborted") {
	console.error("Request failed:", message.errorMessage);
	// message.content contains any partial content received before the error
	// message.usage contains partial token counts and costs
}
```

When using a provider collection, auth failures (OAuth refresh failed, unknown provider) surface as a stream error with `stopReason: "error"`. Direct API `streamSimple()` calls instead throw synchronously when their required auth is absent.

### Aborting Requests

The abort signal allows you to cancel in-progress requests. Aborted requests have `stopReason === 'aborted'`:

```typescript
const controller = new AbortController();

// Abort after 2 seconds
setTimeout(() => controller.abort(), 2000);

const s = models.stream(
	model,
	{
		messages: [{ role: "user", content: "Write a long story", timestamp: Date.now() }],
	},
	{
		signal: controller.signal,
	},
);

for await (const event of s) {
	if (event.type === "text_delta") {
		process.stdout.write(event.delta);
	} else if (event.type === "error") {
		// event.reason tells you if it was "error" or "aborted"
		console.log(`${event.reason === "aborted" ? "Aborted" : "Error"}:`, event.error.errorMessage);
	}
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === "aborted") {
	console.log("Request was aborted:", response.errorMessage);
	console.log("Partial content received:", response.content);
	console.log("Tokens used:", response.usage);
}
```

### Continuing After Abort

Aborted messages can be added to the conversation context and continued in subsequent requests:

```typescript
const context = {
	messages: [{ role: "user", content: "Explain quantum computing in detail", timestamp: Date.now() }],
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: "user", content: "Please continue", timestamp: Date.now() });

// Continue the conversation
const continuation = await models.complete(model, context);
```

### Debugging Provider Payloads

Use the `onPayload` callback to inspect the request payload sent to the provider. This is useful for debugging request formatting issues or provider validation errors.

```typescript
const response = await models.complete(model, context, {
	onPayload: (payload) => {
		console.log("Provider payload:", JSON.stringify(payload, null, 2));
	},
});
```

The callback is supported by `stream`, `complete`, `streamSimple`, and `completeSimple`.

### Observing Provider Stream Events

Use `onProviderStreamEvent` to inspect provider-specific fields that Octocode does not include in `AssistantMessage`. The callback receives the parsed event available to the adapter before Octocode normalizes it. Treat the event as read-only because mutations can affect normalization. This is not guaranteed to be the original HTTP bytes or SSE frame.

```typescript
const openRouterModel = models.getModel("openrouter", "openrouter/auto")!;
const response = await models.complete(openRouterModel, context, {
	headers: { "X-OpenRouter-Metadata": "enabled" },
	onProviderStreamEvent: (data) => {
		const chunk = data as Record<string, unknown>;
		if (chunk.openrouter_metadata) {
			console.log(chunk.openrouter_metadata);
		}
	},
});
```

Callbacks are awaited in stream order, so slow callbacks delay stream consumption and thrown errors fail the request. SDK-backed adapters can expose only fields retained by their SDK.
