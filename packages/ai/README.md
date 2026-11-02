# @octocodeai/octocode-ai

Unified LLM API with provider collections, automatic auth resolution, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

This README covers the provider library API. The coding-agent application owns `models.json`, stored credentials and model selection; see [configuration locations](../../CONFIGURATIONS.md) and its [models guide](../coding-agent/docs/models.md).

**Note**: The chat catalog only includes models that support tool calling (function calling), as this is essential for agentic workflows. Image and classifier catalogs use their operation-specific capabilities.

## Documentation

This README covers installation, the provider list and a quick start. The rest of the library guide lives in `docs/`:

| Page | Covers |
| --- | --- |
| [Providers and models](docs/providers-and-models.md) | Provider factories, built-in providers, model queries, static catalog reads, dynamic providers, migrating from the old global API |
| [Auth](docs/auth.md) | How auth resolves, request header transforms, the credential store, provider environment variables |
| [Tools](docs/tools.md) | Defining tools, constrained sampling, handling and streaming tool calls, argument validation, the event reference |
| [Images](docs/images.md) | Image input and image generation |
| [Classification](docs/classification.md) | Classifier models, OpenAI Decisions, chat models on llama.cpp |
| [Thinking and stop reasons](docs/thinking-and-stop-reasons.md) | Unified and provider-specific reasoning options, streaming thinking, stop reasons |
| [Errors and observability](docs/errors-and-observability.md) | Telemetry, error handling, aborts, continuing after abort, payload and stream-event debugging |
| [Custom providers](docs/custom-providers.md) | `createProvider()`, calling API implementations directly, OpenAI compatibility settings |
| [Faux provider for tests](docs/faux-provider.md) | Scripted responses for tests |
| [Conversations](docs/conversations.md) | Cross-provider handoffs, system messages, context serialization |
| [Browser usage and bundling](docs/browser-and-bundling.md) | Browser use, tree shaking, provider-scoped environment overrides, vendor model discovery |
| [OAuth providers](docs/oauth.md) | Vertex AI, CLI login, programmatic OAuth, provider notes |
| [Development](docs/development.md) | Adding a new provider |

## Supported Providers

- **OpenAI** (including the Decisions classifier API)
- **Ant Ling**
- **Azure OpenAI (Responses)**
- **OpenAI Codex (legacy)** (ChatGPT Plus/Pro subscription, requires [OAuth](docs/oauth.md))
- **TypeSafe** (System One classifier API)
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI** (Gemini via Vertex AI)
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan (Global)** (with separate China provider)
- **MiniMax** (with separate China provider)
- **Together AI**
- **Baseten**
- **Hugging Face**
- **Moonshot AI** (with separate China provider)
- **GitHub Copilot** (requires [OAuth](docs/oauth.md))
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks** (uses OpenAI- and Anthropic-compatible APIs)
- **Kimi For Coding** (Moonshot AI subscription endpoint, uses Anthropic-compatible API)
- **Meta** (Model API, uses OpenAI Responses-compatible API)
- **Qwen Token Plan** (separate Individual and existing catalogs, with a separate China provider)
- **Xiaomi MiMo** (defaults to API billing endpoint, with separate Token Plan providers for `cn`/`ams`/`sgp` regions)
- **Any OpenAI-compatible API**: Ollama, vLLM, LM Studio, etc.

## Installation

```bash
npm install @octocodeai/octocode-ai
```

TypeBox exports are re-exported from `@octocodeai/octocode-ai`: `Type`, `Static`, and `TSchema`.

## Quick Start

You build a `Models` collection of providers and stream through it. The quickest start registers every built-in provider; apps that care about bundle size register individual providers instead (see [Provider Factories](docs/providers-and-models.md#provider-factories) and [Bundling and Tree Shaking](docs/browser-and-bundling.md#bundling-and-tree-shaking)).

```typescript
import { Type, type Context, type Tool } from "@octocodeai/octocode-ai";
import { builtinModels } from "@octocodeai/octocode-ai/providers/all";

// A Models collection with every built-in provider registered
const models = builtinModels();

// Sync lookup against the collection
const model = models.getModel("openai", "gpt-4o-mini")!;

// Define tools with TypeBox schemas for type safety and validation
const tools: Tool[] = [
	{
		name: "get_time",
		description: "Get the current time",
		parameters: Type.Object({
			timezone: Type.Optional(Type.String({ description: "Optional timezone (e.g., America/New_York)" })),
		}),
	},
];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "What time is it?", timestamp: Date.now() }],
	tools,
};

// Option 1: Streaming with all event types.
// Auth resolves through the provider (OPENAI_API_KEY from the environment here).
const s = models.stream(model, context);

for await (const event of s) {
	switch (event.type) {
		case "start":
			console.log(`Starting with ${event.partial.model}`);
			break;
		case "text_start":
			console.log("\n[Text started]");
			break;
		case "text_delta":
			process.stdout.write(event.delta);
			break;
		case "text_end":
			console.log("\n[Text ended]");
			break;
		case "thinking_start":
			console.log("[Model is thinking...]");
			break;
		case "thinking_delta":
			process.stdout.write(event.delta);
			break;
		case "thinking_end":
			console.log("[Thinking complete]");
			break;
		case "toolcall_start":
			console.log(`\n[Tool call started: index ${event.contentIndex}]`);
			break;
		case "toolcall_delta":
			// Partial tool arguments are being streamed
			const partialCall = event.partial.content[event.contentIndex];
			if (partialCall.type === "toolCall") {
				console.log(`[Streaming args for ${partialCall.name}]`);
			}
			break;
		case "toolcall_end":
			console.log(`\nTool called: ${event.toolCall.name}`);
			console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
			break;
		case "done":
			console.log(`\nFinished: ${event.reason}`);
			break;
		case "error":
			console.error(`Error: ${event.error.errorMessage}`);
			break;
	}
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter((b) => b.type === "toolCall");
for (const call of toolCalls) {
	const result =
		call.name === "get_time"
			? new Date().toLocaleString("en-US", {
					timeZone: call.arguments.timezone || "UTC",
					dateStyle: "full",
					timeStyle: "long",
				})
			: "Unknown tool";

	// Add tool result to context (supports text and images)
	context.messages.push({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: result }],
		isError: false,
		timestamp: Date.now(),
	});
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
	const continuation = await models.complete(model, context);
	context.messages.push(continuation);
	console.log("After tool execution:", continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await models.complete(model, context);

for (const block of response.content) {
	if (block.type === "text") {
		console.log(block.text);
	} else if (block.type === "toolCall") {
		console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
	}
}
```

Snippets in this README and the pages under `docs/` assume a `models` collection set up like this (with the relevant providers registered).

`usage.cost` estimates inference charges from the selected provider's catalog rates and reported tokens. Known long-context tiers, cache-write lifetimes and served OpenAI service tiers affect the estimate. A time-limited price carries `cost.until` (last UTC day, inclusive) and `cost.after` (the rates, and tiers, from the next day); `calculateCost(model, usage, now?)` picks the period by the clock, which tests can inject; output usage can include billable reasoning tokens. Subscription allowances, account credits, regional premiums and time-based cache-storage fees are not fully represented. Refresh catalog metadata as prices change.

## License

MIT
