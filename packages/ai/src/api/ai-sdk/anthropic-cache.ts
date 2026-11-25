import type { ModelMessage, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Model, TranscriptContext } from "../../types.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import { getAnthropicCompat, getLayeredCacheControl } from "../anthropic-messages/compat.ts";
import { resolveLayeredCacheRetention } from "../../utils/cache-policy.ts";
import { CACHE_PROFILES, countHistoryTurns, planCacheMarkers } from "../../utils/cache-profiles.ts";
import { splitSystemMessageIntoBlocks } from "../../utils/instruction-split.ts";
import { getInitialSystemMessage } from "../../utils/transcript.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { modelKey, type RequestDiagnostics } from "./request-diagnostics.ts";

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
	diagnostics?: RequestDiagnostics,
): boolean {
	const compat = getAnthropicCompat(model);
	const requested = resolveLayeredCacheRetention(options);
	const { instructions, history } = getLayeredCacheControl(model, requested, options.env);
	const initial = getInitialSystemMessage(context.messages);
	const split =
		instructions && initial
			? splitSystemMessageIntoBlocks(
					initial,
					options.instructionCacheBoundary,
					options.instructionVolatileBoundary,
					options.instructionWorkspaceBoundary,
				)
			: undefined;
	const names = Object.keys(tools).filter((name) => name !== "__octocode_deferred_placeholder__");
	const sharedEnd =
		instructions && compat.supportsCacheControlOnTools && options.toolCacheBoundary
			? Math.max(0, names.indexOf(options.toolCacheBoundary))
			: 0;
	const plan = planCacheMarkers(CACHE_PROFILES.anthropic, {
		instructionBlocks: split ? split.cached.length : instructions && initial ? 1 : 0,
		workspaceBlock: split?.workspace === true,
		instructions: instructions !== undefined,
		history: history !== undefined,
		historyTurns: countHistoryTurns(messages),
		tools: compat.supportsCacheControlOnTools ? names.length : 0,
		toolBoundary: sharedEnd > 0,
	});
	const downgraded =
		!compat.supportsLongCacheRetention &&
		((requested.instructions === "long" && instructions !== undefined && (plan.tool || plan.blocks.some(Boolean))) ||
			(requested.history === "long" && history !== undefined && plan.history > 0));
	if (downgraded)
		// The marker still goes out, at the 5-minute tier: only the lifetime is lost.
		diagnostics?.report(
			"cache_retention_downgraded",
			{
				requested: "1h",
				sent: "5m",
				model: model.id,
				fix: "This host is not verified for 1-hour cache entries. If it accepts them, set the model's compat.supportsLongCacheRetention to true.",
			},
			modelKey(model),
		);
	const ttls = new Set<string>();
	const markWith = (target: { providerOptions?: ProviderOptions }, control: Control) => {
		mark(target, control);
		ttls.add(control.ttl ?? "5m");
	};
	if (instructions && messages[0]?.role === "system" && initial) {
		if (split) {
			messages.splice(
				0,
				1,
				...split.cached.map((text, index): ModelMessage => {
					const message: ModelMessage = { role: "system", content: sanitizeSurrogates(text) };
					if (plan.blocks[index]) markWith(message, instructions);
					return message;
				}),
				...(split.volatile === undefined
					? []
					: [{ role: "system" as const, content: sanitizeSurrogates(split.volatile) }]),
			);
		} else if (plan.blocks[0]) markWith(messages[0], instructions);
	}
	if (instructions && plan.tool) {
		const tool = tools[names[sharedEnd > 0 ? sharedEnd - 1 : names.length - 1]];
		if (tool) markWith(tool, instructions);
	}
	let tailIndex = messages.length - 1;
	while (tailIndex >= 0 && messages[tailIndex].role === "system" && messages[tailIndex].content === "") tailIndex--;
	const tail = messages[tailIndex];
	if (history && plan.history > 0 && markTail(tail, history)) {
		ttls.add(history.ttl ?? "5m");
		if (plan.history > 1) {
			let assistant = tailIndex - 1;
			while (assistant >= 0 && messages[assistant].role !== "assistant") assistant--;
			let previous = assistant - 1;
			while (previous >= 0 && messages[previous].role === "system" && messages[previous].content === "") previous--;
			if (previous >= 0 && markTail(messages[previous], history)) ttls.add(history.ttl ?? "5m");
		}
	}
	return ttls.size === 1 && ttls.has("1h");
}
