#!/usr/bin/env node

import {
	applyAnthropicAllowedFallbackModelMetadata,
	applyAnthropicMessagesCompatMetadata,
	applyStrictToolCompatMetadata,
	isAnthropicFallbackMetadataModel,
} from "./generate-models/anthropic.ts";
import { addAzureModels, addMissingAliasModels } from "./generate-models/aliases-azure-models.ts";
import { buildProviderCatalogs, sortProviderCatalogs } from "./generate-models/catalog.ts";
import { loadModelsDevClassifierModels } from "./generate-models/classifiers.ts";
import { XAI_BUILTIN_EXCLUDED_MODEL_IDS } from "./generate-models/constants.ts";
import { fetchAiGatewayModels, fetchOpenRouterModels } from "./generate-models/fetchers.ts";
import { addDeepSeekAndAntLingModels, addMissingOpenAiModels } from "./generate-models/manual-models.ts";
import { applyImageInputMetadata, applyPromptCacheMetadata } from "./generate-models/metadata.ts";
import { loadModelsDevData } from "./generate-models/models-dev.ts";
import {
	applyOpenAICompletionsCompatMetadata,
	applyOpenAICompletionsTranscriptMetadata,
	applyOpenAIExplicitPromptCacheMetadata,
	applyOpenAIGrammarToolCompatMetadata,
	applyOpenAIMidConvoEffortMetadata,
	applyOpenAIResponsesTranscriptMetadata,
	applyOpenAIToolSearchMetadata,
} from "./generate-models/openai-compat.ts";
import { applyModelsDevReasoningOptionMetadata, applyThinkingLevelMetadata } from "./generate-models/thinking.ts";
import { applyUpstreamCorrections } from "./generate-models/upstream-corrections.ts";
import { writeModelCatalogs } from "./generate-models/writers.ts";

async function generateModels() {
	// Fetch models from all upstream catalogs.
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras, and others
	// OpenRouter: its tool-capable routed catalog
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	const modelsDevModels = await loadModelsDevData();
	const modelsDevClassifierModels = await loadModelsDevClassifierModels();
	const openRouterCatalog = await fetchOpenRouterModels();
	const aiGatewayCatalog = await fetchAiGatewayModels();

	// Combine chat models (models.dev has priority where sources overlap).
	const allModels = [...modelsDevModels, ...openRouterCatalog.chat, ...aiGatewayCatalog.chat].filter(
		(model) =>
			!(model.provider === "xai" && XAI_BUILTIN_EXCLUDED_MODEL_IDS.has(model.id)) &&
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark"),
	);

	applyUpstreamCorrections(allModels);
	addMissingOpenAiModels(allModels);
	addDeepSeekAndAntLingModels(allModels);
	addMissingAliasModels(allModels);
	addAzureModels(allModels);

	for (const model of allModels) {
		applyOpenAICompletionsCompatMetadata(model);
		applyAnthropicMessagesCompatMetadata(model);
		applyModelsDevReasoningOptionMetadata(model);
		applyThinkingLevelMetadata(model);
		applyStrictToolCompatMetadata(model);
		applyOpenAIGrammarToolCompatMetadata(model);
		applyOpenAIToolSearchMetadata(model);
		applyOpenAICompletionsTranscriptMetadata(model);
		applyOpenAIResponsesTranscriptMetadata(model);
		applyOpenAIExplicitPromptCacheMetadata(model);
		applyOpenAIMidConvoEffortMetadata(model);
		applyPromptCacheMetadata(model);
		applyImageInputMetadata(model);
	}
	applyAnthropicAllowedFallbackModelMetadata(allModels.filter(isAnthropicFallbackMetadataModel));

	const providers = buildProviderCatalogs(allModels, openRouterCatalog, aiGatewayCatalog, modelsDevClassifierModels);
	writeModelCatalogs(sortProviderCatalogs(providers));

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter((model) => model.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(
			`  ${provider}: ${Object.keys(models.chat).length} chat models, ${Object.keys(models.image).length} image models, ${Object.keys(models.classifier).length} classifier models`,
		);
	}
}

// Run the generator
generateModels().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
