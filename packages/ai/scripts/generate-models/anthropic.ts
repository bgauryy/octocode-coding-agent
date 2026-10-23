import type { AnthropicMessagesCompat, Api, Model } from "../../src/types.ts";
import {
	ANTHROPIC_ALLOWED_FALLBACK_MODELS,
	EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS,
} from "./constants.ts";
import { mergeThinkingLevelMap } from "./thinking-levels.ts";

/** Anthropic Messages compat: effort, thinking and fallback metadata by model and provider. */

const VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS = new Set(["anthropic", "openrouter"]);
// OpenRouter rejects `configuration_update` system messages on Opus 5 ("Mid-conversation
// reasoning effort (configuration_update) is not supported on anthropic/claude-opus-5-20260723")
// while accepting them on Fable 5.1, so gate that model there.
const MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS = new Set(["openrouter:anthropic/claude-opus-5"]);

function supportsAnthropicMidConvoEffort(modelId: string): boolean {
	const id = modelId.toLowerCase().replace(/^~?anthropic\//, "");
	return (
		/^claude-opus-(?:5|5[.-]5)(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)(?:-\d{8})?$/.test(id)
	);
}

// Claude models that accept `thinking: {type: "disabled"}` alongside per-message effort.
// Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 reject it.
// https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking
const ANTHROPIC_DISABLED_THINKING_MODELS = new Set(["claude-opus-5", "claude-haiku-5-5", "claude-haiku-5.5"]);

function supportsAnthropicDisabledThinkingWithMidConvoEffort(modelId: string): boolean {
	// Strip OpenRouter's "anthropic/" or "~anthropic/" prefix and any dated snapshot suffix.
	const id = modelId
		.toLowerCase()
		.replace(/^~?anthropic\//, "")
		.replace(/-\d{8}$/, "");
	return ANTHROPIC_DISABLED_THINKING_MODELS.has(id);
}

function supportsAnthropicMidConvoSystemMessages(modelId: string): boolean {
	return (
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)?(?:-\d{8})?$/.test(modelId)
	);
}

export function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("opus-4-8") ||
		modelId.includes("opus-4.8") ||
		modelId.includes("opus-5") ||
		modelId.includes("opus.5") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6") ||
		modelId.includes("sonnet-5") ||
		modelId.includes("sonnet.5") ||
		modelId.includes("haiku-5") ||
		modelId.includes("haiku.5") ||
		modelId.includes("fable-5") ||
		modelId.includes("mythos-5")
	);
}

export function isAnthropicTemperatureUnsupportedModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id.includes("opus-4-7") ||
		id.includes("opus-4.7") ||
		id.includes("opus-4-8") ||
		id.includes("opus-4.8") ||
		id.includes("opus-5") ||
		id.includes("opus.5") ||
		id.includes("sonnet-5-5") ||
		id.includes("sonnet-5.5") ||
		id.includes("haiku-5-5") ||
		id.includes("haiku-5.5")
	);
}

export function mergeAnthropicMessagesCompat(model: Model<Api>, compat: AnthropicMessagesCompat): void {
	model.compat = { ...(model.compat as AnthropicMessagesCompat | undefined), ...compat };
}

export function applyAnthropicMessagesCompatMetadata(model: Model<Api>): void {
	if (model.api !== "anthropic-messages") return;
	const compat = getAnthropicMessagesCompat(model.provider, model.id);
	if (compat) {
		mergeAnthropicMessagesCompat(model, compat);
		if (compat.supportsMidConvoEffort && !supportsAnthropicDisabledThinkingWithMidConvoEffort(model.id)) {
			mergeThinkingLevelMap(model, { off: null });
		}
	}
}

export function isAnthropicFallbackMetadataModel(model: Model<Api>): model is Model<"anthropic-messages"> {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	return (
		model.id in ANTHROPIC_ALLOWED_FALLBACK_MODELS ||
		Object.values(ANTHROPIC_ALLOWED_FALLBACK_MODELS).some((fallbackModelIds) => fallbackModelIds.includes(model.id))
	);
}

export function applyAnthropicAllowedFallbackModelMetadata(models: readonly Model<"anthropic-messages">[]): void {
	const modelsById = new Map(models.map((model) => [model.id, model]));
	for (const [modelId, fallbackModelIds] of Object.entries(ANTHROPIC_ALLOWED_FALLBACK_MODELS)) {
		const model = modelsById.get(modelId);
		if (!model) continue;

		const compatibleFallbackModelIds = model.compat?.supportsMidConvoEffort
			? fallbackModelIds.filter(supportsAnthropicMidConvoEffort)
			: fallbackModelIds;
		const allowedFallbackModels = compatibleFallbackModelIds.flatMap((fallbackModelId) => {
			const fallbackModel = modelsById.get(fallbackModelId);
			return fallbackModel
				? [{ provider: fallbackModel.provider, model: fallbackModel.id, cost: fallbackModel.cost }]
				: [];
		});
		if (allowedFallbackModels.length > 0) {
			mergeAnthropicMessagesCompat(model, { allowedFallbackModels });
		}
	}
}

export function applyStrictToolCompatMetadata(model: Model<Api>): void {
	if ((model.provider === "openai" || model.provider === "cloudflare-ai-gateway") && model.api === "openai-responses") {
		model.compat = { ...model.compat, supportsStrictMode: true };
	} else if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsStrictTools: true });
	}
}

export function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	const compat: AnthropicMessagesCompat = {};
	if (
		VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS.has(provider) &&
		supportsAnthropicMidConvoEffort(modelId) &&
		!MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)
	) {
		compat.supportsMidConvoEffort = true;
	}
	if (provider === "anthropic" && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
		compat.supportsMidConvoToolChanges = true;
	}
	// OpenCode Zen and GitHub Copilot forward mid-conversation system messages but reject
	// `tool_addition`/`tool_removal` blocks, so tool changes stay top-level there.
	if ((provider === "opencode" || provider === "github-copilot") && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
	}
	if (EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)) {
		compat.supportsEagerToolInputStreaming = false;
	}
	if (provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")) {
		compat.allowEmptySignature = true;
	}
	// OpenCode Qwen 3.8 Flash emits and accepts thinking blocks with empty signatures.
	if ((provider === "opencode" || provider === "opencode-go") && modelId === "qwen3.8-flash") {
		compat.allowEmptySignature = true;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}
