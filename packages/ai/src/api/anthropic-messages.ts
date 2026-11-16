import type { Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { clampThinkingLevel } from "../models/model-helpers.ts";
import { getCurrentTools, resolveTranscript } from "../utils/transcript.ts";
import { failStreamTask } from "./lazy.ts";
import { streamSdk } from "./ai-sdk/stream.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { hasStrictToolDowngrade } from "./anthropic-messages/strict-tool-downgrades.ts";
import { anthropicStrictFetch } from "./ai-sdk/anthropic-request.ts";
import { copilotDynamicHeadersFor } from "./github-copilot-headers.ts";
import { anthropicBetaHeader } from "./ai-sdk/anthropic-headers.ts";
import { anthropicSdkInput } from "./ai-sdk/anthropic-input.ts";
import { getAnthropicCompat } from "./anthropic-messages/compat.ts";
import { assertRequestAuth, getAnthropicFederation } from "./anthropic-messages/federation.ts";
import { fitClaudeThinkingBudget } from "./anthropic-messages/thinking-budget.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	thinkingBudgetForLevel,
	thinkingBudgetReduction,
} from "./simple-options.ts";
import type { AnthropicEffort, AnthropicOptions } from "./anthropic-messages/types.ts";

export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./anthropic-messages/types.ts";

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (model, context, requestOptions = {}) => {
	const events = new AssistantMessageEventStream();
	const run = async () => {
		const normalized = resolveTranscript(context, getAnthropicCompat(model).supportsMidConvoSystemMessages);
		const options = {
			...requestOptions,
			headers: {
				...copilotDynamicHeadersFor(model.provider, normalized.messages),
				...requestOptions.headers,
				"anthropic-beta": anthropicBetaHeader(model, normalized, requestOptions),
			},
		};
		const mapping = anthropicSdkInput(
			model,
			normalized,
			options,
			hasStrictToolDowngrade(model, getCurrentTools(normalized.messages)),
		);
		const strict: { message?: string } = {};
		const fetch = anthropicStrictFetch(model, normalized, options, strict, mapping.finalizeRequest);
		for await (const event of streamSdk(model, normalized, { ...options, fetch }, mapping)) {
			if (strict.message) {
				const output = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
				appendAssistantMessageDiagnostic(output, {
					type: "anthropic_strict_tools_fallback",
					timestamp: Date.now(),
					error: { message: strict.message },
					details: { reason: "strict_tool_limits_exceeded" },
				});
				strict.message = undefined;
			}
			events.push(event);
		}
		events.end();
	};
	run().catch((error: unknown) => failStreamTask(events, model, error, requestOptions.signal));
	return events;
};

function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (model, context, options) => {
	if (!getAnthropicFederation(model, options?.apiKey, options?.headers, options?.env))
		assertRequestAuth(model.provider, options?.apiKey, { ...model.headers, ...options?.headers });
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AnthropicOptions;
	if (!options?.reasoning) {
		const lowest =
			model.reasoning && model.thinkingLevelMap?.off === null ? clampThinkingLevel(model, "minimal") : "off";
		const least = lowest === "off" ? undefined : mapThinkingLevelToEffort(model, lowest);
		return stream(model, context, { ...base, thinkingEnabled: false, ...(least ? { effort: least } : {}) });
	}
	if (model.compat?.forceAdaptiveThinking === true)
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort: mapThinkingLevelToEffort(model, options.reasoning),
		});
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	const thinkingBudgetTokens = fitClaudeThinkingBudget(adjusted.thinkingBudget, maxTokens);
	const reduction = thinkingBudgetReduction(
		fitClaudeThinkingBudget(thinkingBudgetForLevel(options.reasoning, options.thinkingBudgets), model.maxTokens),
		thinkingBudgetTokens,
	);
	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: thinkingBudgetTokens !== 0,
		...(thinkingBudgetTokens ? { thinkingBudgetTokens } : {}),
		thinkingBudgetReduction: reduction,
	});
};
