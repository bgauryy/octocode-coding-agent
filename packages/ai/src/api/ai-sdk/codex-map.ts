import type { Model, TranscriptContext } from "../../types.ts";
import { getInitialSystemMessage } from "../../utils/transcript.ts";
import { getSystemMessageText } from "../../utils/text.ts";
import { resolveCacheAffinityId, resolveCacheRetention } from "../../utils/cache-policy.ts";
import { clampOpenAIPromptCacheKey } from "../openai-prompt-cache.ts";
import type { OpenAICodexResponsesOptions } from "../openai-codex-responses/types.ts";
import type { OpenAIResponsesOptions } from "../openai-responses/types.ts";
import { resolveCodexServiceTier, applyServiceTierPricing } from "../openai-codex-responses/request.ts";
import { calculateCost } from "../../models/model-helpers.ts";
import { responsesMapping } from "./responses-map.ts";
import type { SdkMapping } from "./stream.ts";

export function codexMapping(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options: OpenAICodexResponsesOptions,
): SdkMapping {
	const sharedOptions: OpenAIResponsesOptions = {
		...options,
		reasoningEffort: options.reasoningEffort === "none" ? undefined : options.reasoningEffort,
		reasoningSummary:
			options.reasoningSummary === "off" || options.reasoningSummary === "on" ? "auto" : options.reasoningSummary,
	};
	const mapping = responsesMapping(
		{ ...model, compat: { ...model.compat, supportsStrictMode: model.compat?.supportsStrictMode ?? true } },
		sharedOptions,
		context,
	);
	let serviceTier = options.serviceTier;
	const initial = getInitialSystemMessage(context.messages);
	return {
		...mapping,
		messages: mapping.messages?.length ? mapping.messages : [{ role: "user", content: "" }],
		augmentRequest(body) {
			mapping.augmentRequest?.(body);
			body.store = false;
			if (!mapping.messages?.length) body.input = [];
			body.instructions = (initial && getSystemMessageText(initial)) || "You are a helpful assistant.";
			if (Array.isArray(body.input) && initial) {
				const index = body.input.findIndex((item) => item.role === "system" || item.role === "developer");
				if (index >= 0) body.input.splice(index, 1);
			}
			delete body.max_output_tokens;
			body.text = { ...(body.text as object), verbosity: options.textVerbosity ?? "low" };
			body.include = ["reasoning.encrypted_content"];
			body.parallel_tool_calls = true;
			body.tool_choice = options.toolChoice ?? "auto";
			const key =
				resolveCacheRetention(options.cacheRetention, options.env) === "none"
					? undefined
					: clampOpenAIPromptCacheKey(resolveCacheAffinityId(options));
			if (key === undefined) delete body.prompt_cache_key;
			else body.prompt_cache_key = key;
			delete body.prompt_cache_retention;
			delete body.prompt_cache_options;
			if (options.reasoningEffort === "none") {
				if (model.thinkingLevelMap?.off === null) delete body.reasoning;
				else
					body.reasoning = {
						effort: model.thinkingLevelMap?.off ?? "none",
						summary: options.reasoningSummary ?? "auto",
					};
			}
		},
		onPart(part, output, stream) {
			if (part.type === "raw") {
				const event = part.rawValue as { response?: { end_turn?: boolean } };
				if (typeof event.response?.end_turn === "boolean") output.endTurn = event.response.end_turn;
			}
			if (part.type === "finish-step" && typeof part.providerMetadata?.openai?.serviceTier === "string")
				serviceTier = resolveCodexServiceTier(
					part.providerMetadata.openai.serviceTier as OpenAICodexResponsesOptions["serviceTier"],
					options.serviceTier,
				);
			const handled = mapping.onPart(part, output, stream);
			if (part.type === "finish") {
				calculateCost(model, output.usage);
				applyServiceTierPricing(output.usage, serviceTier, model);
			}
			return handled;
		},
	};
}
