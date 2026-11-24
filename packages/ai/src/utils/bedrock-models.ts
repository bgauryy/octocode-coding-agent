import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "../types.ts";

import { isBedrockInferenceHost } from "./provider-host.ts";

const KIMI_31 = /^(?:(?:global|us|in)\.)?moonshotai\.kimi-k3\.1$/;
export const KIMI_K3_MAX_TOKENS = 131072;

/** AWS model cards specify flat effort for these Bedrock IDs, including their geographic inference profiles. */
function bedrockEffortLevels(id: string): ThinkingLevelMap | undefined {
	const base = id.replace(/^(?:global|us|eu|apac|in)\./, "");
	const kimi = /^moonshotai\.kimi-k3(?:\.1)?$/.test(base);
	if (!kimi && base !== "zai.glm-5.3") return undefined;
	return {
		off: kimi ? "none" : null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};
}

/** Bedrock's OpenAI-compatible endpoints and Converse share these effort values even for a custom provider. */
export function bedrockRequestEffort(model: Model<Api>, requested?: ThinkingLevel): string | undefined {
	const levels = bedrockEffortLevels(model.id);
	if (
		!levels ||
		!model.reasoning ||
		(model.api !== "bedrock-converse-stream" && !isBedrockInferenceHost(model.baseUrl))
	)
		return undefined;
	return levels[requested ?? "off"] ?? "low";
}

/** Kimi K3.1 served by Bedrock Runtime, including geographic/global profiles and custom Bedrock endpoints. */
export function isBedrockKimi31(model: Model<Api>): boolean {
	return KIMI_31.test(model.id) && (model.api === "bedrock-converse-stream" || isBedrockInferenceHost(model.baseUrl));
}

/** Kimi's final output TPM burndown is 10x; choose a normal reply by default while explicit budgets still win. */
export function bedrockReplyBudget(model: Model<Api>, requested?: number): number | undefined {
	if (!isBedrockKimi31(model)) return undefined;
	return Math.min(requested ?? 8192, model.maxTokens, KIMI_K3_MAX_TOKENS);
}

export function isBedrockNova2(id: string): boolean {
	return /^(?:(?:global|us|eu|jp)\.)?amazon\.nova-2-lite-v1:0$/.test(id);
}

const MANAGED: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: null,
};

/** Keep hydrated releases and freshly generated catalogs consistent for these provider-specific limits and rates. */
export function withBedrockModelCapabilities<T extends Model<Api>>(model: T): T {
	if (model.provider !== "amazon-bedrock") return model;
	const levels = bedrockEffortLevels(model.id);
	if (!levels) {
		if (!model.reasoning || model.api !== "bedrock-converse-stream") return model;
		if (isBedrockNova2(model.id))
			return { ...model, thinkingLevelMap: { ...MANAGED, off: "none", low: "low", medium: "medium", high: "high" } };
		// Converse reasoning controls are model-specific. Don't advertise effort tiers the adapter cannot send.
		if (!model.thinkingLevelMap && !/(?:anthropic[./]claude|openai[./]gpt)/i.test(model.id))
			return { ...model, thinkingLevelMap: { ...MANAGED } };
		return model;
	}
	const kimi31 = KIMI_31.test(model.id);
	const geo = /^(us|in)\./.test(model.id);
	return {
		...model,
		reasoning: true,
		thinkingLevelMap: levels,
		...(kimi31
			? {
					maxTokens: Math.min(model.maxTokens, KIMI_K3_MAX_TOKENS),
					cost: {
						...model.cost,
						input: geo ? 4.4 : 4,
						output: geo ? 22 : 20,
						cacheRead: geo ? 0.22 : 0.2,
						cacheWrite: geo ? 5.5 : 5,
					},
				}
			: {}),
	};
}
