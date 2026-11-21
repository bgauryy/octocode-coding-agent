import type { ModelMessage, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Model, TranscriptContext } from "../../types.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import { getAnthropicCompat, getLayeredCacheControl } from "../anthropic-messages/compat.ts";
import { resolveLayeredCacheRetention } from "../../utils/cache-policy.ts";
import { keepsToolBreakpoint, splitSystemMessageIntoBlocks } from "../../utils/instruction-split.ts";
import { getInitialSystemMessage } from "../../utils/transcript.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";

type Control = { type: "ephemeral"; ttl?: "1h" | "5m" };
function mark(target: { providerOptions?: ProviderOptions }, control: Control): void {
	target.providerOptions = {
		...target.providerOptions,
		anthropic: { ...target.providerOptions?.anthropic, cacheControl: control },
	};
}
function markTail(message: ModelMessage | undefined, control: Control): boolean {
	if (!message || message.role === "assistant") return false;
	if (typeof message.content === "string") {
		if (!message.content.trim()) return false;
		mark(message, control);
		return true;
	}
	const part = message.content.at(-1);
	if (!part || part.type === "tool-approval-response" || (part.type === "text" && !part.text.trim())) return false;
	mark(part, control);
	return true;
}
export function anthropicSdkCache(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
	messages: ModelMessage[],
	tools: ToolSet,
): boolean {
	const compat = getAnthropicCompat(model);
	const { instructions, history } = getLayeredCacheControl(model, resolveLayeredCacheRetention(options), options.env);
	const initial = getInitialSystemMessage(context.messages);
	const split =
		instructions && initial
			? splitSystemMessageIntoBlocks(initial, options.instructionCacheBoundary, options.instructionVolatileBoundary)
			: undefined;
	const names = Object.keys(tools).filter((name) => name !== "__octocode_deferred_placeholder__");
	const sharedEnd =
		instructions && compat.supportsCacheControlOnTools && options.toolCacheBoundary
			? Math.max(0, names.indexOf(options.toolCacheBoundary))
			: 0;
	let count = 0;
	const ttls = new Set<string>();
	const countMark = (control: Control) => {
		count++;
		ttls.add(control.ttl ?? "5m");
	};
	if (instructions && messages[0]?.role === "system" && initial) {
		if (split) {
			messages.splice(
				0,
				1,
				...split.cached.map((text, index): ModelMessage => {
					const message: ModelMessage = { role: "system", content: sanitizeSurrogates(text) };
					if (!(sharedEnd > 0 && split.cached.length > 1 && index === 0)) {
						mark(message, instructions);
						countMark(instructions);
					}
					return message;
				}),
				...(split.volatile === undefined
					? []
					: [{ role: "system" as const, content: sanitizeSurrogates(split.volatile) }]),
			);
		} else {
			mark(messages[0], instructions);
			countMark(instructions);
		}
	}
	if (instructions && compat.supportsCacheControlOnTools) {
		const tool = tools[names[sharedEnd > 0 ? sharedEnd - 1 : names.length - 1]];
		if (tool && (sharedEnd > 0 || keepsToolBreakpoint(split))) {
			mark(tool, instructions);
			countMark(instructions);
		}
	}
	let tailIndex = messages.length - 1;
	while (tailIndex >= 0 && messages[tailIndex].role === "system" && messages[tailIndex].content === "") tailIndex--;
	const tail = messages[tailIndex];
	if (history && markTail(tail, history)) {
		countMark(history);
		if (count < 4) {
			let assistant = tailIndex - 1;
			while (assistant >= 0 && messages[assistant].role !== "assistant") assistant--;
			let previous = assistant - 1;
			while (previous >= 0 && messages[previous].role === "system" && messages[previous].content === "") previous--;
			if (previous >= 0 && markTail(messages[previous], history)) countMark(history);
		}
	}
	return ttls.size === 1 && ttls.has("1h");
}
