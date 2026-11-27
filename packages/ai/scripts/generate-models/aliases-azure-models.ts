import { getEffortThinkingLevelMap } from "../../src/catalog/models-dev-fields.ts";
import type { Api, Model, ModelCost, OpenAICompletionsCompat } from "../../src/types.ts";
import { getModelKey, modelsDevReasoningOptions } from "./thinking-levels.ts";

/** Mistral Medium 3.5 until models.dev lists it, and the OpenRouter router aliases. */
export function addMissingAliasModels(allModels: Model<any>[]): void {
	// Add missing Mistral Medium 3.5 model until models.dev includes it
	if (!allModels.some((m) => m.provider === "mistral" && m.id === "mistral-medium-3.5")) {
		allModels.push({
			id: "mistral-medium-3.5",
			name: "Mistral Medium 3.5",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: true,
			thinkingLevelMap: getEffortThinkingLevelMap([{ type: "effort", values: ["none", "high"] }]),
			input: ["text", "image"],
			cost: {
				input: 1.5,
				output: 7.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144, // 256k tokens
			maxTokens: 262144,
		});
	}

	// Add "auto" alias for openrouter/auto
	if (!allModels.some((m) => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	// Add "fusion" alias for openrouter/fusion. OpenRouter exposes Fusion as a
	// router alias/plugin entry point; its model metadata does not advertise
	// tools, but the alias resolves to a concrete model that can invoke caller
	// tools and has the openrouter:fusion server tool auto-injected.
	if (!allModels.some((m) => m.provider === "openrouter" && m.id === "openrouter/fusion")) {
		allModels.push({
			id: "openrouter/fusion",
			name: "OpenRouter: Fusion",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				// we dont know about the costs because Fusion routes to multiple models
				// and then charges you for the underlying used models
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 30000,
		});
	}
}

/** Azure clones of the OpenAI Responses models and of DeepSeek V4 Pro. */
export function addAzureModels(allModels: Model<any>[]): void {
	// Azure Foundry deploys these with larger context windows than OpenAI's own short-tier defaults.
	// See models-sold-directly-by-azure docs.
	const AZURE_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
		"gpt-5.4": 1050000,
		"gpt-5.5": 1050000,
		"gpt-5.6-luna": 1050000,
		"gpt-5.6-sol": 1050000,
		"gpt-5.6-terra": 1050000,
	};
	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "",
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			// The OpenAI endpoint's prompt ceiling is not a limit on an Azure deployment.
			inputLimits: undefined,
			contextWindow: AZURE_CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
	// Reasoning options are recorded per provider, and thinking-level maps are derived from them after
	// cloning, so a clone must carry its source's options; otherwise o-series clones accept "none" and
	// "minimal", which the deployment rejects.
	for (const model of azureOpenAiModels) {
		const reasoningOptions = modelsDevReasoningOptions.get(getModelKey({ provider: "openai", id: model.id }));
		if (reasoningOptions) modelsDevReasoningOptions.set(getModelKey(model), reasoningOptions);
	}
	allModels.push(...azureOpenAiModels);

	// Azure resells DeepSeek at its own rates. US data zone.
	// https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/deepseek/
	const AZURE_DEEPSEEK_V4_PRO_COST: ModelCost = { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 };
	// Azure 400s on DeepSeek's `thinking` field and on every prompt cache parameter, discards a
	// `developer` system message unbilled once reasoning_effort is set, and honours mid-convo ones (#9645).
	const azureDeepSeekModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "deepseek" && model.id === "deepseek-v4-pro")
		.map((model) => ({
			...model,
			provider: "azure",
			baseUrl: "",
			cost: AZURE_DEEPSEEK_V4_PRO_COST,
			compat: {
				...(model.compat as OpenAICompletionsCompat),
				supportsDeveloperRole: false,
				supportsMidConvoSystemMessages: true,
				thinkingFormat: "openai",
				supportsLongCacheRetention: false,
			},
		}));
	allModels.push(...azureDeepSeekModels);
}
