import type { Model, ThinkingLevel } from "../../types.ts";
import { effortLevel, effortValue } from "../../models/model-helpers.ts";
import { bedrockRequestEffort, isBedrockNova2 } from "../../utils/bedrock-models.ts";
import { thinkingBudgetForLevel } from "../simple-options.ts";
import { getConfiguredBedrockRegion } from "./client-config.ts";
import { getModelMatchCandidates, isAnthropicClaudeModel, supportsAdaptiveThinking } from "./model-match.ts";
import { mapThinkingLevelToEffort, supportsThinkingBlockBinding } from "./model-support.ts";
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
	const effort = bedrockRequestEffort(model, options.reasoning);
	if (effort !== undefined) return { reasoning_effort: effort };
	if (model.reasoning && isBedrockNova2(model.id) && options.reasoning) {
		return { reasoningConfig: { type: "enabled", maxReasoningEffort: OPENAI_GPT_OSS_EFFORT[options.reasoning] } };
	}
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
		const adaptiveEffort = mapThinkingLevelToEffort(model, options.reasoning);
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: {
						type: "adaptive",
						...(display !== undefined ? { display } : {}),
						...(useBlockBinding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
					},
					...(adaptiveEffort ? { output_config: { effort: adaptiveEffort } } : {}),
					...(useBlockBinding ? { anthropic_beta: [THINKING_BINDING_CONTROLS_BETA] } : {}),
				}
			: {
					thinking: {
						type: "enabled",
						budget_tokens: thinkingBudgetForLevel(options.reasoning, options.thinkingBudgets),
						...(display !== undefined ? { display } : {}),
					},
				};

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
		const level = effortLevel(model, options.reasoning);
		const effort = effortValue(model, options.reasoning) ?? (level ? OPENAI_GPT_EFFORT[level] : undefined);
		return effort ? { reasoning: { effort } } : {};
	}

	if (model.thinkingLevelMap && Object.values(model.thinkingLevelMap).every((level) => level === null))
		throw new Error(
			`Bedrock Converse has no configurable reasoning effort for ${model.id}. Leave effort automatic for this route.`,
		);
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
