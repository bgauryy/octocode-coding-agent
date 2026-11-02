# @octocodeai/octocode-agent-core

Stateful agent with tool execution and event streaming. Built on `@octocodeai/octocode-ai`.

This package receives models, tools and policy from its host. For the coding-agent application's files and settings, use [CONFIGURATIONS.md](../../CONFIGURATIONS.md).

## Installation

```bash
npm install @octocodeai/octocode-agent-core
```

## Quick Start

```typescript
import { Agent } from "@octocodeai/octocode-agent-core";
import { createModels } from "@octocodeai/octocode-ai";
import { anthropicProvider } from "@octocodeai/octocode-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
	initialState: {
		systemPrompt: "You are a helpful assistant.",
		model,
	},
	streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		// Stream just the new text chunk
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await agent.prompt("Hello!");
```

## Core Concepts

### AgentMessage vs LLM Message

The agent works with `AgentMessage`, a flexible type that can include:

- Standard LLM messages (`user`, `assistant`, `toolResult`)
- Custom app-specific message types via declaration merging

LLMs only understand `user`, `assistant`, and `toolResult`. The `convertToLlm` function bridges this gap by filtering and transforming messages before each LLM call.

### Message Flow

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (optional)                           (required)
```

1. **transformContext**: Prune old messages, inject external context
2. **convertToLlm**: Filter out UI-only messages, convert custom types to LLM format

## Documentation

| Page | Covers |
| --- | --- |
| [Event flow](docs/events.md) | `prompt()` and tool-call event sequences, request preparation, turn finalization, `continue()`, queued input, event types |
| [Options, state and methods](docs/options-and-state.md) | Agent options, agent state, prompting, state management, budgets, control, event subscription |
| [Steering, messages and tools](docs/messages-and-tools.md) | Steering and follow-up input, custom message types, tools, tool errors, MCP tools |
| [Proxy and low-level API](docs/proxy-and-low-level.md) | Proxy usage and the low-level agent loop |

## License

MIT
