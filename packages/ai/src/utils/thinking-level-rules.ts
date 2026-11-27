import type { ReasoningOption as ModelsDevReasoningOption } from "@opencode-ai/models";
import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "../types.ts";
import { hasProviderProfile, type ProfiledModel } from "./provider-profile.ts";

/**
 * Which effort levels a model accepts, by provider and model id. The model generator applies these rules to the
 * built-in catalog and the host applies them to models a user defines, so both agree.
 */

export type { ModelsDevReasoningOption };

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Converts models.dev verified effort values into Octocode's selectable thinking levels.
 * Values without an Octocode equivalent (`default` and JSON `null`) are intentionally
 * omitted.
 */
export function getEffortThinkingLevelMap(options: readonly ModelsDevReasoningOption[]): ThinkingLevelMap | undefined {
	const effortValues = options.flatMap((option) => (option.type === "effort" ? option.values : []));
	if (effortValues.length === 0) return undefined;

	const supported = new Set(effortValues);
	if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return undefined;

	const map: ThinkingLevelMap = { off: supported.has("none") ? "none" : null };
	for (const level of THINKING_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

export function mergeThinkingLevelMap(model: { thinkingLevelMap?: ThinkingLevelMap }, map: ThinkingLevelMap): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6") ||
		modelId.includes("gpt-6")
	);
}

function supportsOpenAiMax(model: Pick<Model<Api>, "id" | "api">): boolean {
	return (
		(model.id.includes("gpt-5.6") || model.id.includes("gpt-6")) &&
		(model.api === "openai-responses" || model.api === "azure-openai-responses" || model.api === "openai-completions")
	);
}

const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
export const DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP = {
	...DEEPSEEK_V4_THINKING_LEVEL_MAP,
	low: "low",
} as const;
// Azure Foundry rejects DeepSeek's own max effort.
const AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const;

const ANT_LING_RING_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "xhigh",
} as const;

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-sol",
	"gpt-6-luna",
]);

// Checked manually against the authenticated GitHub Copilot /models endpoint on 2026-06-15.
// Keep this to narrow corrections over models.dev metadata instead of snapshotting Copilot's catalog.
const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES: Readonly<
	Record<string, NonNullable<Model<Api>["thinkingLevelMap"]> | undefined>
> = {
	"claude-opus-4.7": { minimal: "low" },
	"claude-opus-4.8": { minimal: "low" },
	"claude-opus-5": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
};

/** The model fields the rules read. */
export type ThinkingRuleModel = Pick<
	Model<Api>,
	"id" | "provider" | "api" | "reasoning" | "thinkingLevelMap" | "compat"
> &
	Pick<ProfiledModel, "baseUrl" | "profile">;

/** Merges every rule that matches `model` into its `thinkingLevelMap`, keeping levels a rule does not name. */
export function applyThinkingLevelRules(model: ThinkingRuleModel): void {
	if ((model.api === "openai-responses" || model.api === "azure-openai-responses") && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (
		(model.id === "gpt-6-astra" ||
			model.id === "gpt-6-sol" ||
			model.id === "gpt-6-luna" ||
			model.id === "gpt-6.1-sol") &&
		(model.api === "openai-responses" || model.api === "azure-openai-responses")
	) {
		mergeThinkingLevelMap(model, {
			// GPT-6 Astra and GPT-6.1 Sol reject reasoning.effort "none".
			off: model.id === "gpt-6-astra" || model.id === "gpt-6.1-sol" ? null : "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	if (model.provider === "github-copilot" && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		model.api === "openai-responses" &&
		hasProviderProfile(model, "openai") &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	// xAI models without verified effort options must not send the undocumented
	// "none"/"minimal" efforts.
	if (hasProviderProfile(model, "xai") && model.api === "openai-responses" && model.thinkingLevelMap === undefined) {
		mergeThinkingLevelMap(model, { off: null, minimal: null });
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (hasProviderProfile(model, "openai") && model.id === "gpt-5.5") {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
	}
	// Anthropic adaptive-thinking effort support (per Anthropic adaptive thinking docs):
	// - "max" is available on all adaptive-thinking Claude models.
	// - "xhigh" is only available on Opus 4.7/4.8/5, Sonnet 5, Haiku 5.5, and Fable 5.
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("opus.5") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("sonnet.5") ||
		model.id.includes("haiku-5") ||
		model.id.includes("haiku.5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("fable-5")) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	if (model.api === "openai-completions" && model.id.includes("deepseek-v4") && model.thinkingLevelMap === undefined) {
		mergeThinkingLevelMap(
			model,
			hasProviderProfile(model, "openrouter")
				? { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null }
				: model.provider === "azure"
					? AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP
					: (model.provider === "deepseek" || model.provider === "opencode" || model.provider === "opencode-go") &&
						  model.id.includes("deepseek-v4-flash")
						? DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP
						: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		);
	}
	if (hasProviderProfile(model, "groq") && model.id === "qwen/qwen3.6-27b") {
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null, high: "default" });
	}
	if (
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn") &&
		(model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed")
	) {
		// Kimi K2.7 Code is always-thinking. Official docs say
		// `thinking: { type: "disabled" }` is rejected, and callers can omit
		// the thinking parameter to use the enabled default.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (hasProviderProfile(model, "openrouter") && model.id.startsWith("inception/mercury-2")) {
		// Mercury 2 in instant mode (reasoning_effort: "none") disables tool calling.
		// Mark "off" unsupported so the openai-completions provider omits the reasoning param
		// instead of defaulting to {reasoning:{effort:"none"}} (see openai-completions.ts:575).
		// Octocode's low/medium/high pass through verbatim; OpenRouter normalizes to Mercury's vocabulary.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (hasProviderProfile(model, "openrouter") && model.id === "z-ai/glm-5.2") {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.provider === "fireworks") {
		if (model.api === "anthropic-messages" && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking) {
			// Qwen Max currently advertises only a toggle. Prefer upstream effort
			// metadata once available instead of replacing it with this fallback.
			if (model.id === "accounts/fireworks/models/qwen3p8-max" && !model.thinkingLevelMap) {
				model.thinkingLevelMap = getEffortThinkingLevelMap([{ type: "effort", values: ["low", "medium", "xhigh"] }]);
			}
			if (model.id === "accounts/fireworks/models/qwen3p8-2p4t-a95b") {
				// The 2.4T alias omits the verified toggle in models.dev.
				mergeThinkingLevelMap(model, { off: "none" });
			}
			if (model.id === "accounts/fireworks/models/deepseek-v4-pro-0813") {
				mergeThinkingLevelMap(model, { low: "low" });
			}
		}
		if (model.id.includes("glm-5p2")) {
			// GLM 5.2 and its fast router support off/high/max. Fireworks maps low
			// and medium to high, so do not expose those aliases as distinct levels.
			mergeThinkingLevelMap(model, { off: "none", minimal: null, low: null, medium: null, max: "max" });
		}
		if (model.id.includes("kimi-k3")) {
			// Fireworks maps medium to high on both APIs; do not expose it as a distinct level.
			mergeThinkingLevelMap(model, { medium: null });
		}
	}
	if (model.provider === "opencode-go" && model.id === "glm-5.2") {
		mergeThinkingLevelMap(model, OPENCODE_GO_GLM52_THINKING_LEVEL_MAP);
	}
	if (model.provider === "opencode-go" && model.id === "kimi-k2.6") {
		// OpenCode Go exposes Kimi K2.6 thinking as on/off, not distinct effort tiers.
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null });
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen Grok Build reasons by default but rejects explicit reasoningEffort.
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (hasProviderProfile(model, "ant-ling") && model.reasoning) {
		// Ring reasons by default. Only high/xhigh have documented explicit effort controls.
		mergeThinkingLevelMap(model, ANT_LING_RING_THINKING_LEVEL_MAP);
	}
	if (model.provider === "github-copilot") {
		const override = GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES[model.id];
		if (override) {
			mergeThinkingLevelMap(model, override);
		}
	}
}

/**
 * The effort map the rules give a model that has none, or undefined when no rule matches or the model does not
 * reason. A map the model already has is the caller's to keep.
 */
export function inferThinkingLevelMap(model: ThinkingRuleModel): ThinkingLevelMap | undefined {
	if (!model.reasoning || model.thinkingLevelMap !== undefined) return undefined;
	const probe: ThinkingRuleModel = { ...model };
	applyThinkingLevelRules(probe);
	return probe.thinkingLevelMap;
}
