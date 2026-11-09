# Tools

Part of the [`@octocodeai/octocode-ai` guide](../README.md). Snippets assume a `models` collection set up as in the [Quick Start](../README.md#quick-start).

Tools enable LLMs to interact with external systems. This library uses TypeBox schemas for type-safe tool definitions with automatic validation using TypeBox's built-in validator and value conversion utilities. TypeBox schemas can be serialized and deserialized as plain JSON, making them ideal for distributed systems.

## Defining Tools

```typescript
import { Type, type Tool, StringEnum } from "@octocodeai/octocode-ai";

// Define tool parameters with TypeBox
const weatherTool: Tool = {
	name: "get_weather",
	description: "Get current weather for a location",
	parameters: Type.Object({
		location: Type.String({ description: "City name or coordinates" }),
		units: StringEnum(["celsius", "fahrenheit"], { default: "celsius" }),
	}),
};

// Note: For Google API compatibility, use StringEnum helper instead of Type.Enum
// Type.Enum generates anyOf/const patterns that Google doesn't support

const bookMeetingTool: Tool = {
	name: "book_meeting",
	description: "Schedule a meeting",
	parameters: Type.Object({
		title: Type.String({ minLength: 1 }),
		startTime: Type.String({ format: "date-time" }),
		endTime: Type.String({ format: "date-time" }),
		attendees: Type.Array(Type.String({ format: "email" }), { minItems: 1 }),
	}),
};
```

## Constrained Sampling for Tools

Tools can opt in to provider-side constrained sampling. For JSON-schema tools, `strict: 'prefer'` uses provider-side strict schema enforcement when supported and otherwise falls back to normal tool calling. `strict: 'require'` fails the request when the active provider/model cannot honor it. Set `constrainedSampling: false` to explicitly opt out; it behaves the same as omitting the field.

```typescript
const strictTool: Tool = {
	name: "edit_file",
	description: "Edit a file",
	parameters: Type.Object(
		{
			path: Type.String(),
			content: Type.String(),
		},
		{ additionalProperties: false },
	),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};
```

Strict JSON-schema constrained sampling is supported for OpenAI, Anthropic, supported Amazon Bedrock Converse models, Mistral, and Gemini 3 tool calls through the Google Generative AI and Vertex adapters. Google uses `VALIDATED` function-calling mode (or `ANY` when explicitly requested); earlier Gemini versions fall back for `strict: 'prefer'` and reject `strict: 'require'` because they do not enforce required parameters. Bedrock strict-tool capability is generated from model structured-output metadata; custom Bedrock models can override `compat.supportsStrictMode`. OpenAI Responses and Chat Completions can also emit grammar-constrained custom tools with OpenAI Lark or regex grammar variants. If multiple OpenAI variants are supplied, Lark is preferred over regex. Grammar constraints are enforced when the active model supports grammar tools; otherwise the tool falls back to normal function/JSON-schema handling. Grammar tool capability is model metadata: the generated catalog sets `compat.supportsOpenAIGrammarTools` for GPT-5+ models on endpoints that pass OpenAI custom tools through (OpenAI, OpenAI Codex, Azure OpenAI Responses, GitHub Copilot, opencode, and Cloudflare AI Gateway). OpenAI rejects `type: "custom"` tools for pre-GPT-5 models, and gateways that normalize tool schemas (e.g. OpenRouter) mangle them, so the flag stays off elsewhere. Custom model definitions can opt in via `compat`. Grammar-capable models reject grammar configurations without a non-empty supported variant. Native grammar tools must have an object parameter schema with exactly one required string property:

```typescript
const patchTool: Tool = {
	name: "apply_patch",
	description: "Apply a patch",
	parameters: Type.Object(
		{
			input: Type.String(),
		},
		{ additionalProperties: false },
	),
	constrainedSampling: {
		type: "grammar",
		variants: {
			openai_lark: "start: /.+/s",
		},
	},
};
```

## Handling Tool Calls

Tool results use content blocks and can include both text and images:

```typescript
import { readFileSync } from "fs";

const context: Context = {
	messages: [{ role: "user", content: "What is the weather in London?", timestamp: Date.now() }],
	tools: [weatherTool],
};

const response = await models.complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
	if (block.type === "toolCall") {
		// Execute your tool with the arguments
		// See "Validating Tool Arguments" section for validation
		const result = await executeWeatherApi(block.arguments);

		// Add tool result with text content
		context.messages.push({
			role: "toolResult",
			toolCallId: block.id,
			toolName: block.name,
			content: [{ type: "text", text: JSON.stringify(result) }],
			isError: false,
			timestamp: Date.now(),
		});
	}
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = readFileSync("chart.png");
context.messages.push({
	role: "toolResult",
	toolCallId: "tool_xyz",
	toolName: "generate_chart",
	content: [
		{ type: "text", text: "Generated chart showing temperature trends" },
		{ type: "image", data: imageBuffer.toString("base64"), mimeType: "image/png" },
	],
	isError: false,
	timestamp: Date.now(),
});
```

## Streaming Tool Calls with Partial JSON

During streaming, tool call arguments are progressively parsed as they arrive. This enables real-time UI updates before the complete arguments are available:

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete (but not yet validated)
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

Partial arguments during `toolcall_delta` are a best-effort parse: fields may be missing, strings truncated mid-word, arrays and nested objects incomplete; the value is at least `{}`, never `undefined`. Check each field before use. Google does not stream function calls: it sends one `toolcall_delta` with the full arguments.

## Validating Tool Arguments

When implementing your own tool execution loop, use `validateToolCall` to validate arguments before passing them to your tools:

```typescript
import { validateToolCall, type Tool } from "@octocodeai/octocode-ai";

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
	if (event.type === "toolcall_end") {
		const toolCall = event.toolCall;

		try {
			// Validate arguments against the tool's schema (throws on invalid args)
			const validatedArgs = validateToolCall(tools, toolCall);
			const result = await executeMyTool(toolCall.name, validatedArgs);
			// ... add tool result to context
		} catch (error) {
			// Validation failed - return error as tool result so model can retry
			context.messages.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: error.message }],
				isError: true,
				timestamp: Date.now(),
			});
		}
	}
}
```

## Complete Event Reference

Successful generation follows `start → updates* → done`. A failure after generation starts follows `start → updates* → error`. Request setup may fail before generation starts, in which case the stream contains only `error`; `done` and update events are invalid before `start`. Direct API `streamSimple()` calls throw synchronously when request auth is missing.

Every non-terminal event's `partial` is the shared live response-so-far helper. It is intentionally not an event-time snapshot: providers may mutate the same message and content blocks as generation advances, including while older events wait in the stream queue. Inspect it when handling an event instead of retaining it as historical state. Text and ordinary thinking blocks are empty when their `*_start` event is emitted and grow only through matching `*_delta` events until the authoritative `*_end`; redacted thinking may be complete at start and emit no deltas. Tool-call arguments at `toolcall_start` are provider-specific; `toolcall_delta` carries subsequent JSON updates.

All streaming events emitted during assistant message generation:

| Event Type       | Description                                                    | Key Properties                                                                              |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `start`          | Stream begins                                                  | `partial`: Initial assistant message structure                                              |
| `text_start`     | Text block starts                                              | `contentIndex`: Position in content array                                                   |
| `text_delta`     | Text chunk received                                            | `delta`: New text, `contentIndex`: Position                                                 |
| `text_end`       | Text block complete                                            | `content`: Full text, `contentIndex`: Position                                              |
| `thinking_start` | Thinking block starts                                          | `contentIndex`: Position in content array                                                   |
| `thinking_delta` | Thinking chunk received                                        | `delta`: New text, `contentIndex`: Position                                                 |
| `thinking_end`   | Thinking block complete                                        | `content`: Full thinking, `contentIndex`: Position                                          |
| `toolcall_start` | Tool call begins                                               | `contentIndex`: Position in content array                                                   |
| `toolcall_delta` | Tool arguments streaming                                       | `delta`: JSON chunk, `partial.content[contentIndex].arguments`: Partial parsed args         |
| `toolcall_end`   | Tool call complete                                             | `toolCall`: Complete, but not schema-validated, tool call with `id`, `name`, `arguments`    |
| `content_update` | Attachment, source annotation, or other complete block changed | `contentIndex`: Replace this block with `partial.content[contentIndex]`                     |
| `done`           | Stream complete                                                | `reason`: Stop reason ("stop", "length", "toolUse"), `message`: Final assistant message     |
| `error`          | Error occurred                                                 | `reason`: Error type ("error" or "aborted"), `error`: AssistantMessage with partial content |

Streaming events for different content blocks are not guaranteed to be contiguous. Providers may emit deltas for text, thinking, and tool calls in the same upstream chunk, and Octocode may surface corresponding events interleaved, for example `text_start`, `text_delta`, `toolcall_start`, `text_delta`, `toolcall_delta`. Consumers must use `contentIndex` to associate each delta/end event with its block and must not assume that a block's `*_start`/`*_delta`/`*_end` sequence is uninterrupted by events for other blocks.

`AssistantMessage.content` preserves ordered text, thinking, tool calls, images, media, resource references, and explicit unsupported-output blocks. Text may carry `annotations` with citation sources. Images use base64 `data` and `mimeType`; media can contain bytes or a URI, while resources carry a URI. An unsupported block names the provider output type so interfaces can show a fallback. Provider continuation signatures are opaque replay data and must not be displayed.

Provider support differs: Responses preserves generated images, partial images, audio bytes and transcripts; Gemini preserves inline media and file references; Bedrock preserves streamed images; Mistral preserves image parts. Source annotations are retained from Responses, Anthropic, Gemini, and Bedrock. Responses audio events do not identify their codec, so their bytes use `application/octet-stream` for download. On cross-provider replay, generated artifacts become explicit text descriptions when the target cannot accept them in assistant messages.

Known provider-native tools retain their visible payloads as readable text/JSON: Responses search, code, computer, shell, patch and MCP outputs; Gemini server calls and results; Anthropic server-tool inputs, search/fetch/execution/MCP results and visible compaction text; and Bedrock native result text/JSON. These summaries preserve queries, code, logs, result fields, file identifiers, URLs and status without executing server tools locally. Execution configuration and opaque continuation, signature, encrypted, context and authentication fields are excluded. Unrecognized or opaque-only output stays an explicit unsupported block; this display normalization does not implement provider-native continuation protocols.
