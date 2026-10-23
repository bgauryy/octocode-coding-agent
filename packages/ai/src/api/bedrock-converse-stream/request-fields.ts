import type { Model, ThinkingLevel } from "../../types.ts";
import { getConfiguredBedrockRegion } from "./client-config.ts";
import {
	getModelMatchCandidates,
	isAnthropicClaudeModel,
	mapThinkingLevelToEffort,
	supportsAdaptiveThinking,
	supportsThinkingBlockBinding,
} from "./model-support.ts";
import { type BedrockOptions, THINKING_BINDING_CONTROLS_BETA } from "./types.ts";

function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

export function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (isAnthropicClaudeModel(model)) {
		// GovCloud Bedrock currently rejects the Claude thinking.display field.
		// Omit it there until the GovCloud Converse schema catches up.
		const isGovCloud = isGovCloudBedrockTarget(model, options);
		const display = isGovCloud ? undefined : (options.thinkingDisplay ?? "summarized");
		// Replayed signed thinking blocks are bound to the system prompt and tools they were
		// created with. Bedrock 400s on replay after either changes unless stale blocks are
		// dropped, matching the Anthropic provider. Skipped on GovCloud like display.
		const useBlockBinding = !isGovCloud && supportsThinkingBlockBinding(model);
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: {
						type: "adaptive",
						...(display !== undefined ? { display } : {}),
						...(useBlockBinding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
					},
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
					...(useBlockBinding ? { anthropic_beta: [THINKING_BINDING_CONTROLS_BETA] } : {}),
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // Budget-based Claude clamps extended levels to high
						max: 16384,
					};

					// Custom budgets only cover token-based levels through high.
					const level = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
							...(display !== undefined ? { display } : {}),
						},
					};
				})();

		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	const candidates = getModelMatchCandidates(model.id, model.name);

	if (candidates.some((s) => s.includes("gpt-oss"))) {
		return { reasoning_effort: OPENAI_GPT_OSS_EFFORT[options.reasoning] };
	}

	if (candidates.some((s) => s.includes("gpt-"))) {
		const mapped = model.thinkingLevelMap?.[options.reasoning];
		return {
			reasoning: { effort: typeof mapped === "string" ? mapped : OPENAI_GPT_EFFORT[options.reasoning] },
		};
	}

	return undefined;
}

type OpenAIGptEffort = "low" | "medium" | "high" | "xhigh" | "max";
type OpenAIGptOssEffort = "low" | "medium" | "high";

/** OpenAI GPT models (GPT-5.x, GPT-6) take a nested `reasoning.effort` and reject `minimal`. */
const OPENAI_GPT_EFFORT: Record<ThinkingLevel, OpenAIGptEffort> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** gpt-oss takes a flat `reasoning_effort` and only accepts low, medium and high. */
const OPENAI_GPT_OSS_EFFORT: Record<ThinkingLevel, OpenAIGptOssEffort> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};
