import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "../types.ts";
import { getCompat as getCompletionsCompat } from "../api/openai-completions/compat.ts";
import { isAnthropicClaudeModel, supportsAdaptiveThinking } from "../api/bedrock-converse-stream/model-match.ts";
import { usesGoogleThinkingLevel } from "../api/ai-sdk/google-thinking-format.ts";

/**
 * How thinking is requested: `toggle` enables or disables it, `effort` names a level, `budget` sends a token budget, `level` is Gemini's discrete
 * `thinkingLevel`, and `managed` means the provider controls reasoning without user-selectable levels.
 */
export type ThinkingControl = "none" | "toggle" | "effort" | "budget" | "level" | "managed";

export function thinkingControl(model: Model<Api>): ThinkingControl {
	if (!model.reasoning) return "none";
	switch (model.api) {
		case "anthropic-messages":
			return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking ? "effort" : "budget";
		case "bedrock-converse-stream":
			return isAnthropicClaudeModel(model as Model<"bedrock-converse-stream">) &&
				!supportsAdaptiveThinking(model.id, model.name)
				? "budget"
				: "effort";
		case "google-generative-ai":
		case "google-vertex":
			return usesGoogleThinkingLevel(model as Model<"google-generative-ai">) ? "level" : "budget";
		case "openai-completions": {
			const compat = getCompletionsCompat(model as Model<"openai-completions">);
			const format = compat.thinkingFormat;
			const template =
				format === "baseten"
					? compat.chatTemplateArgs
					: format === "chat-template"
						? compat.chatTemplateKwargs
						: undefined;
			const variables = Object.values(template ?? {}).flatMap((value) =>
				typeof value === "object" && value !== null ? [value.$var] : [],
			);
			if (compat.thinkingTokenBudgetField || variables.includes("thinking.budget")) return "budget";
			if (format === "qwen-chat-template") return "toggle";
			if (format === "openrouter" || format === "string-thinking" || variables.includes("thinking.effort"))
				return "effort";
			if (format === "ant-ling")
				return Object.entries(model.thinkingLevelMap ?? {}).some(
					([level, value]) => level !== "off" && typeof value === "string",
				)
					? "effort"
					: "none";
			if (compat.supportsReasoningEffort) return "effort";
			if (
				variables.includes("thinking.enabled") ||
				format === "qwen" ||
				format === "deepseek" ||
				format === "zai" ||
				format === "together"
			)
				return "toggle";
			return "none";
		}
		default:
			return "effort";
	}
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function supportedLevels(model: Model<Api>, control: ThinkingControl): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	if (control === "none" && !Object.keys(model.samplingParamsByThinkingLevel ?? {}).length) return [];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function resolveModelThinking(model: Model<Api>) {
	const control = thinkingControl(model);
	const levels = supportedLevels(model, control);
	return { control: levels.length ? control : ("managed" as const), levels, canDisable: levels.includes("off") };
}

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	return supportedLevels(model, thinkingControl(model));
}

/**
 * The one rule that turns a requested thinking level into a level the model supports, for every adapter: the level
 * itself when supported (a `thinkingLevelMap` entry, or its absence for a plain level, is the alias), else the nearest
 * lower supported level, else the lowest supported one (never `off` for a request to think, unless nothing else is
 * supported).
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex - 1; i >= (level === "off" ? 0 : 1); i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels.find((candidate) => candidate !== "off") ?? availableLevels[0] ?? "off";
}

/**
 * The level a request to think at `level` is sent as. A level the model's `thinkingLevelMap` marks unsupported (`null`)
 * goes through {@link clampThinkingLevel}; any other level is sent as asked, because an adapter knows natively which
 * `xhigh` and `max` values its provider takes when the map is silent. A model whose map leaves no level to think at
 * (every level `null`) has no effort to send: the result is undefined and the adapter sends no effort field.
 */
export function effortLevel<TApi extends Api>(model: Model<TApi>, level: ThinkingLevel): ThinkingLevel | undefined {
	if (model.thinkingLevelMap?.[level] !== null) return level;
	const clamped = clampThinkingLevel(model, level);
	return clamped === "off" ? undefined : clamped;
}

/** The provider value the model's `thinkingLevelMap` gives the clamped level; undefined where the map is silent. */
export function effortValue<TApi extends Api>(model: Model<TApi>, level: ThinkingLevel): string | undefined {
	const effective = effortLevel(model, level);
	const mapped = effective ? model.thinkingLevelMap?.[effective] : undefined;
	return typeof mapped === "string" ? mapped : undefined;
}
