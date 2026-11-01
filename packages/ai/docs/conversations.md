# Conversations

Part of the [`@octocodeai/octocode-ai` guide](../README.md). Covers moving a conversation between providers, system messages and saving context.

## Cross-Provider Handoffs

The library supports seamless handoffs between different LLM providers within the same conversation. This allows you to switch models mid-conversation while preserving context, including text, tool calls, and tool results.

When messages from one provider are sent to a different provider, the library automatically transforms them for compatibility:

- **User and tool result messages** are passed through unchanged
- **Assistant messages from the same provider, API, and model** are preserved as-is, including thinking blocks
- **Assistant messages from a different model** have their thinking blocks dropped. Signatures and encrypted reasoning only work with the model that produced them, and readable thinking sent as plain text makes the new model treat it as part of the reply
- **Tool calls and regular text** are preserved unchanged

```typescript
import { createModels, type Context } from "@octocodeai/octocode-ai";
import { anthropicProvider } from "@octocodeai/octocode-ai/providers/anthropic";
import { openaiProvider } from "@octocodeai/octocode-ai/providers/openai";
import { googleProvider } from "@octocodeai/octocode-ai/providers/google";

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// Start with Claude
const claude = models.getModel("anthropic", "claude-sonnet-4-5")!;
context.messages.push({ role: "user", content: "What is 25 * 18?", timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: "medium" }));

// Switch to GPT-5 - it sees Claude's answer, but not Claude's thinking
const gpt5 = models.getModel("openai", "gpt-5-mini")!;
context.messages.push({ role: "user", content: "Is that calculation correct?", timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// Switch to Gemini
const gemini = models.getModel("google", "gemini-2.5-flash")!;
context.messages.push({ role: "user", content: "What was the original question?", timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

All providers can handle messages from other providers — text, tool calls and results (including images), thinking blocks (dropped when the model changes), and aborted messages with partial content. This enables flexible workflows: start with a fast model, switch to a more capable one for complex reasoning, or maintain continuity across provider outages.

## System Messages

`Context.systemPrompt` and `Context.tools` are shorthand for a leading system message. The public entry points (`Models.stream()`, `streamSimple()`, `complete()`, `completeSimple()`) accept a `Context` and call `normalizeContext()` once; everything below them, including `Provider.stream()`, `ProviderStreams`, and the API implementation modules, receives the resulting `TranscriptContext`, which only has `messages`. The transcript can also carry system messages later in the conversation to change the prompt or the tool set without rewriting the history:

```typescript
interface SystemMessage {
	role: "system";
	content: string | TextContent[]; // leading: base prompt; later: added instructions
	sections?: Record<string, string | null>; // named prompt sections; later messages patch by name, null removes
	toolsAdded?: Tool[]; // tools that become available here
	toolsRemoved?: ToolReference[]; // tools that stop being available here
	timestamp: number;
}
```

Sections are opaque text rendered verbatim after `content`, joined by blank lines. Keep each one self-delimiting (a tag, a heading) so the model can relate an update to the original. Replaying every system message in order yields the current prompt and tools; the replay helpers take the message list:

```typescript
import { getCurrentSystemPrompt, getCurrentTools } from "@octocodeai/octocode-ai";

const messages: Message[] = [
	{
		role: "system",
		content: "You are helpful.",
		sections: { rules: "<rules>Be brief.</rules>" },
		toolsAdded: [readTool],
		timestamp: 1,
	},
	{ role: "user", content: "hi", timestamp: 2 },
	{
		role: "system",
		content: "",
		sections: { rules: "<rules>Be thorough.</rules>" },
		toolsRemoved: [{ name: "read" }],
		timestamp: 3,
	},
];
getCurrentSystemPrompt(messages); // "You are helpful.\n\n<rules>Be thorough.</rules>"
getCurrentTools(messages); // []
```

A custom `Provider` or `ProviderStreams` implementation reads the prompt and tools the same way from `context.messages`; `context.systemPrompt` and `context.tools` do not exist at that layer.

Models that accept system messages mid-conversation (`supportsMidConvoSystemMessages` in the model's compat settings, set by the generated catalog for verified models) receive each later system message in place, so the cached prefix stays intact; section changes are framed by name for the model. Every other model receives `collapseSystemMessages(transcript)`: the leading system message keeps its text byte-identical (it takes only the current tools, which these APIs send in one top-level field), and each later system message becomes a user message marked as a harness update, placed just before the next assistant message so it never separates a tool call from its result. Updates keep transcript order and name the sections they replace, so the latest wins. Bedrock merges consecutive user turns because Converse requires alternating roles. Mistral's native API rejects a user message after a tool result, so it uses `collapseSystemMessages(transcript, { holdAfterToolResult: true })`: the leading prompt stays byte-identical, an update that would directly follow a tool result is held and merged into the next user message (it reaches the model one turn later), and other updates go before the next assistant message, consecutive ones as a single user message. A transcript without a leading system message is folded with `foldSystemMessages(transcript)`: the replayed prompt and current tools as the leading system message. Anthropic models that also set `supportsMidConvoToolChanges` send tool changes as native blocks (`inline-tools-2026-09-15` beta): the top-level tool list holds the initial tools plus a stable deferred placeholder and never changes, later tools are defined by value in `tool_addition` blocks (a new definition under an existing name replaces the old one), and removals are `tool_removal` references, so tool changes do not invalidate the prompt cache. That needs at least one initial tool; otherwise the current tool list is sent at the top level with the system text only. OpenAI Responses models with `supportsAdditionalTools` declare every tool in `additional_tools` items, like Codex: the initial tools in one at the head of the input and later additions and redefinitions at their message, with no top-level tool list. A later item replaces same-name definitions from earlier items but cannot replace a top-level tool or remove any tool, so removals are announced as text, later updates restate the tools that are still unavailable, and calls to removed tools fail at execution. OpenAI Responses models with only `supportsToolSearch` (all of these need `supportsMidConvoSystemMessages`; without it there is no message to anchor, and the mode is `none`), and Kimi models with `supportsMidConvoToolAdditions`, anchor new tools at their message; a removal or a redeclared name moves the tool state up to that point into the top-level list once. Everything else sends the current tool list at the top level. `getToolLoadingMode(model)` and `supportsNativeToolLoading(model)` (`@octocodeai/octocode-ai/utils/tool-loading`) report the derived mode (`changes`, `additions` or `none`) that adapters and tool-exposure code share.

## Context Serialization

The `Context` object can be easily serialized and deserialized using standard JSON methods, making it simple to persist conversations, implement chat history, or transfer contexts between services:

```typescript
const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "What is TypeScript?", timestamp: Date.now() }],
};

const model = models.getModel("openai", "gpt-4o-mini")!;
const response = await models.complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);

// Save to database, localStorage, file, etc.
localStorage.setItem("conversation", serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem("conversation")!);
restored.messages.push({ role: "user", content: "Tell me more about its type system", timestamp: Date.now() });

// Continue with any model
const newModel = models.getModel("anthropic", "claude-3-5-haiku-20241022")!;
const continuation = await models.complete(newModel, restored);
```

Models are plain serializable data too — no functions or implementations attached — so persisting "which model was this conversation using" is a `JSON.stringify` away.

> **Note**: If the context contains images (encoded as base64 as shown in the Image Input section), those will also be serialized.
