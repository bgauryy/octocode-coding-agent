import { jsonSchema, tool } from "ai";
import { TypeValidationError } from "@ai-sdk/provider";
import type { AssistantMessage, Model, TranscriptContext } from "../../types.ts";
import { resolveCacheRetention, resolvePromptCacheKey } from "../../utils/cache-policy.ts";
import { getCurrentTools, resolveTranscript } from "../../utils/transcript.ts";
import { collapseOptionsFor } from "../../utils/transcript-prefix.ts";
import { transformMessages, NON_VISION_TOOL_IMAGE_PLACEHOLDER } from "../transform-messages.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "../constrained-sampling.ts";
import { createMistralToolCallIdNormalizer } from "../mistral-conversations/tool-call-ids.ts";
import type { MistralOptions } from "../mistral-conversations/types.ts";
import { sdkMessages } from "./messages.ts";
import type { SdkMapping } from "./stream.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { applySdkUsage } from "./events.ts";

export function mistralMapping(
	model: Model<"mistral-conversations">,
	context: TranscriptContext,
	options: MistralOptions = {},
): SdkMapping {
	const normalize = createMistralToolCallIdNormalizer();
	const messages = context.messages.map((message) => {
		if (message.role === "toolResult") return { ...message, toolCallId: normalize(message.toolCallId) };
		if (message.role === "assistant")
			return {
				...message,
				content: (message.content ?? []).map((block) =>
					block.type === "toolCall" ? { ...block, id: normalize(block.id) } : block,
				),
			};
		return message;
	});
	const normalized = resolveTranscript(
		{ messages: transformMessages(messages, model) } as TranscriptContext,
		model.compat?.supportsMidConvoSystemMessages,
		collapseOptionsFor(model.api),
	);
	const choice = options.toolChoice;
	// The SDK joins every text item of a chunk and drops images, so `[text, image, text]` would come out as one text
	// before the image. The mapping writes text and images from the raw chunk in wire order and skips the SDK's text parts;
	// reasoning stays with the SDK.
	let open: { block: Extract<AssistantMessage["content"][number], { type: "text" }>; index: number } | undefined;
	const closeText = (output: AssistantMessage, stream: AssistantMessageEventStream) => {
		if (!open) return;
		stream.push({ type: "text_end", contentIndex: open.index, content: open.block.text, partial: output });
		open = undefined;
	};
	const appendText = (text: unknown, output: AssistantMessage, stream: AssistantMessageEventStream) => {
		if (typeof text !== "string" || !text) return;
		if (open && output.content[output.content.length - 1] !== open.block) closeText(output, stream);
		if (!open) {
			const block = { type: "text" as const, text: "" };
			open = { block, index: output.content.push(block) - 1 };
			stream.push({ type: "text_start", contentIndex: open.index, partial: output });
		}
		open.block.text += text;
		stream.push({ type: "text_delta", contentIndex: open.index, delta: text, partial: output });
	};
	return {
		messages: sdkMessages(model, normalized),
		tools: Object.fromEntries(
			getCurrentTools(normalized.messages).map((definition) => {
				const strict = resolveJsonSchemaStrictSampling(definition, model.compat?.supportsStrictMode ?? true);
				return [
					definition.name,
					tool({
						description: definition.description,
						inputSchema: jsonSchema(JSON.parse(JSON.stringify(getJsonSchemaToolParameters(definition, strict)))),
						strict: strict ?? false,
					}),
				];
			}),
		),
		toolChoice:
			typeof choice === "object"
				? { type: "tool", toolName: choice.function.name }
				: choice === "any"
					? "required"
					: choice,
		includeRawChunks: true,
		onPart: (part, output, stream) => {
			if (part.type === "text-start" || part.type === "text-delta" || part.type === "text-end") return true;
			if (part.type === "reasoning-start" || part.type === "tool-input-start" || part.type === "finish-step")
				closeText(output, stream);
			if (part.type === "raw") {
				const chunk = part.rawValue as { choices?: { delta?: { content?: unknown } }[] };
				const content = chunk.choices?.[0]?.delta?.content;
				if (!Array.isArray(content)) appendText(content, output, stream);
				else
					for (const item of content) {
						if (item?.type === "text") appendText(item.text, output, stream);
						if (item?.type !== "image_url") continue;
						const url = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
						if (typeof url !== "string") continue;
						const embedded = url.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
						closeText(output, stream);
						output.content.push(
							embedded
								? { type: "image", mimeType: embedded[1], data: embedded[2] }
								: { type: "resource", uri: url, name: "Generated image" },
						);
						stream.push({ type: "content_update", contentIndex: output.content.length - 1, partial: output });
					}
				return true;
			}
			if (part.type === "error" && TypeValidationError.isInstance(part.error))
				part.error = new Error(
					`Mistral provider stream error: ${part.error instanceof Error ? part.error.message : String(part.error)}`,
					{ cause: part.error },
				);
			if (part.type !== "finish") return false;
			if (output.rawStopReason === "model_length") part.finishReason = "length";
			if (!["stop", "length", "tool-calls"].includes(part.finishReason)) {
				output.stopReason = "error";
				applySdkUsage(output, part.totalUsage, model);
				output.errorMessage = `Provider stopped with: ${output.rawStopReason ?? part.finishReason}${output.rawStopReason === "error" ? " (server error)" : ""}`;
				return true;
			}
			return false;
		},
		providerOptions: {
			mistral:
				resolveCacheRetention(options.cacheRetention, options.env) !== "none"
					? { promptCacheKey: resolvePromptCacheKey(options) }
					: {},
		},
		augmentRequest: (body) => {
			const messages = body.messages as Array<Record<string, unknown>>;
			for (const [index, message] of messages.entries()) {
				if (message.role === "assistant") message.prefix = false;
				if (
					message.role === "user" &&
					normalized.messages[index]?.role === "user" &&
					typeof normalized.messages[index].content === "string" &&
					Array.isArray(message.content) &&
					message.content.every((part) => part.type === "text")
				)
					message.content = message.content.map((part) => part.text).join("");
				if (message.role === "tool") {
					const result = normalized.messages.find(
						(item) => item.role === "toolResult" && item.toolCallId === message.tool_call_id,
					);
					if (result?.role === "toolResult") {
						const text = result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")
							.trim();
						const images = result.content.filter((part) => part.type === "image");
						const visible = model.input.includes("image");
						const value =
							images.length && !visible
								? [text, NON_VISION_TOOL_IMAGE_PLACEHOLDER].filter(Boolean).join("\n")
								: text || (images.length ? "(see attached image)" : "(no tool output)");
						message.content = [
							{ type: "text", text: `${result.isError ? "[tool error] " : ""}${value}` },
							...(visible
								? images.map((part) => ({ type: "image_url", image_url: `data:${part.mimeType};base64,${part.data}` }))
								: []),
						];
					}
				}
			}
			if (options.promptMode) body.prompt_mode = options.promptMode;
			if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
		},
	};
}
