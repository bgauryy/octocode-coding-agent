# Thinking and stop reasons

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

## Thinking/Reasoning

Many models support reasoning and can return thinking blocks or reasoning summaries. You can check if a model supports reasoning via the `reasoning` property. If you pass reasoning options to a non-reasoning model, they are silently ignored.

### Unified Interface (streamSimple/completeSimple)

```typescript
// Many models across providers support thinking/reasoning
const model = models.getModel("anthropic", "claude-sonnet-4-5")!;
// or models.getModel('openai', 'gpt-5-mini');
// or models.getModel('google', 'gemini-2.5-flash');
// or models.getModel('xai', 'grok-4.7');

// Check if model supports reasoning
if (model.reasoning) {
	console.log("Model supports reasoning/thinking");
}

// Use the simplified reasoning option
const response = await models.completeSimple(
	model,
	{
		messages: [{ role: "user", content: "Solve: 2x + 5 = 13", timestamp: Date.now() }],
	},
	{
		reasoning: "medium", // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
	},
);

// Access thinking and text blocks
for (const block of response.content) {
	if (block.type === "thinking") {
		console.log("Thinking:", block.thinking);
	} else if (block.type === "text") {
		console.log("Response:", block.text);
	}
}
```

Use `getSupportedThinkingLevels(model)` to build selectors from the concrete provider/model's capabilities, including whether thinking can be turned `off`. Some models reject disabled thinking or omit `minimal`. For an Anthropic model that cannot turn thinking off (`thinkingLevelMap.off: null`), `off` through `streamSimple()`/`completeSimple()` requests its least effort instead of the default `high`: adaptive-thinking models receive `thinking.type: "adaptive"` with that effort in `output_config.effort` (for example `low`); `xhigh` and `max` need a `thinkingLevelMap` entry for the model; without one, an adaptive Claude model falls back to `high`. `clampThinkingLevel(model, level)` returns a supported level when restoring a saved choice or switching models. Both helpers are exported from `@octocodeai/octocode-ai`.

### Provider-Specific Options (stream/complete)

`models.stream()`/`complete()` accept the owning API's full option set. Use `hasApi()` to narrow a dynamically looked-up model to its API for full option typing:

```typescript
import { hasApi } from "@octocodeai/octocode-ai";

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = models.getModel("openai", "gpt-5-mini")!;
if (hasApi(openaiModel, "openai-responses")) {
	await models.complete(openaiModel, context, {
		reasoningEffort: "medium",
		reasoningSummary: "detailed", // OpenAI Responses API only
	});
}

// Anthropic Thinking
const anthropicModel = models.getModel("anthropic", "claude-sonnet-4-5")!;
if (hasApi(anthropicModel, "anthropic-messages")) {
	await models.complete(anthropicModel, context, {
		thinkingEnabled: true,
		thinkingBudgetTokens: 8192, // Optional token limit
	});
}

// Google Gemini Thinking
const googleModel = models.getModel("google", "gemini-2.5-flash")!;
if (hasApi(googleModel, "google-generative-ai")) {
	await models.complete(googleModel, context, {
		thinking: {
			enabled: true,
			budgetTokens: 8192, // -1 for dynamic, 0 to disable
		},
	});
}
```

### Streaming Thinking Content

When streaming, thinking content is delivered through specific events:

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

Every `AssistantMessage` includes a `stopReason` field that indicates how the generation ended:

| `stopReason` | Meaning                                      |
| ------------ | -------------------------------------------- |
| `pending`    | Partial messages only: outcome not known yet |
| `stop`       | The model finished its turn                  |
| `length`     | Output hit the token limit                   |
| `toolUse`    | The model called tools and expects results   |
| `error`      | Generation failed                            |
| `aborted`    | Cancelled through the abort signal           |

`AssistantMessage` may also include `responseId`, a provider-specific upstream response or message identifier when the underlying API exposes one. Do not assume it is always present across providers.
