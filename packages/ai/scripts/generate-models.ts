#!/usr/bin/env node

import { join } from "node:path";
import {
	applyAnthropicAllowedFallbackModelMetadata,
	applyAnthropicMessagesCompatMetadata,
	applyStrictToolCompatMetadata,
	isAnthropicFallbackMetadataModel,
} from "./generate-models/anthropic.ts";
import { addAzureModels, addMissingAliasModels } from "./generate-models/aliases-azure-models.ts";
import { buildProviderCatalogs, sortProviderCatalogs } from "./generate-models/catalog.ts";
import { loadModelsDevClassifierModels } from "./generate-models/classifiers.ts";
import { OPENCODE_EXCLUDED_MODEL_IDS, XAI_BUILTIN_EXCLUDED_MODEL_IDS } from "./generate-models/constants.ts";
import { fetchAiGatewayModels, fetchOpenRouterModels } from "./generate-models/fetchers.ts";
import { addDeepSeekAndAntLingModels, addMissingOpenAiModels } from "./generate-models/manual-models.ts";
import { applyImageInputMetadata, applyPromptCacheMetadata } from "./generate-models/metadata.ts";
import { modelsDevLimits } from "../src/catalog/models-dev-fields.ts";
import { loadModelsDevSource } from "./generate-models/models-dev-source.ts";
import { mergeModelsDevSources, modelsDevSources } from "./generate-models/models-dev-sources.ts";
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
import { packageRoot, refreshesProvider } from "./generate-models/options.ts";
import { KNOWN_PROVIDER_IDS, type KnownProvider } from "../src/types/ids.ts";
import { applyModelsDevReasoningOptionMetadata, applyThinkingLevelMetadata } from "./generate-models/thinking.ts";
import { applyUpstreamCorrections } from "./generate-models/upstream-corrections.ts";
import { writeModelCatalogs } from "./generate-models/writers.ts";
import { readModelsDevStamp } from "./model-data.ts";

// Azure derives its catalog from OpenAI and DeepSeek. The other exceptions have their own listings or manual models.
const otherSources = new Set<KnownProvider>([
	"ant-ling",
	"azure",
	"deepseek",
	"openrouter",
	"typesafe",
	"vercel-ai-gateway",
]);
/** Every provider built from models.dev listings, whatever a run refreshes. */
const modelsDevSourced = KNOWN_PROVIDER_IDS.filter((id) => !otherSources.has(id));

async function generateModels() {
	// Upstream catalogs:
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras, and others (the pinned snapshot; `--live` fetches)
	// OpenRouter: its tool-capable routed catalog
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	const modelsDevOwners = modelsDevSourced.filter(
		(id) => refreshesProvider(id) || (id === "openai" && refreshesProvider("azure")),
	);
	const needsCatalog = modelsDevOwners.length > 0 || refreshesProvider("openrouter");
	const source = needsCatalog || refreshesProvider("typesafe") ? await loadModelsDevSource() : undefined;
	const upstream = needsCatalog ? source?.providers : undefined;
	const modelsDevModels = upstream && modelsDevOwners.length ? await loadModelsDevData(upstream) : [];
	const populated = new Set(modelsDevModels.map((model) => model.provider));
	const missing = modelsDevOwners.filter((id) => !populated.has(id));
	if (missing.length) throw new Error(`models.dev returned no usable chat models for: ${missing.join(", ")}`);
	const modelsDevClassifierModels =
		source && refreshesProvider("typesafe") ? await loadModelsDevClassifierModels(source) : [];
	const openRouterCatalog = refreshesProvider("openrouter")
		? await fetchOpenRouterModels()
		: { chat: [], images: [], classifiers: [] };
	const aiGatewayCatalog = refreshesProvider("vercel-ai-gateway")
		? await fetchAiGatewayModels()
		: { chat: [], classifiers: [] };

	// Combine chat models (models.dev has priority where sources overlap).
	const allModels = [...modelsDevModels, ...openRouterCatalog.chat, ...aiGatewayCatalog.chat].filter(
		(model) =>
			!(model.provider === "xai" && XAI_BUILTIN_EXCLUDED_MODEL_IDS.has(model.id)) &&
			!(
				(model.provider === "opencode" || model.provider === "opencode-go") &&
				OPENCODE_EXCLUDED_MODEL_IDS.has(model.id)
			),
	);

	applyUpstreamCorrections(allModels);
	addMissingOpenAiModels(allModels);
	addDeepSeekAndAntLingModels(allModels);
	addMissingAliasModels(allModels);
	addAzureModels(allModels);

	for (const model of allModels) {
		// Gateway and deployment lists supply their own context window. Only supplement an exact, matching route.
		if (model.provider === "azure" || model.provider === "openrouter") {
			const limit = upstream?.[model.provider]?.models?.[model.id]?.limit;
			if (limit && limit.context === model.contextWindow) {
				const { inputLimits } = modelsDevLimits(limit);
				if (inputLimits) model.inputLimits = { ...model.inputLimits, ...inputLimits };
			}
		}
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
	// The manifest records each rebuilt provider's models.dev listing and left-out ids; a run that read no models.dev
	// listings keeps the installed stamp.
	const previous = readModelsDevStamp(join(packageRoot, "src", "providers", "data"));
	writeModelCatalogs(
		sortProviderCatalogs(providers),
		source && upstream && modelsDevOwners.length > 0
			? {
					generatedAt: source.generatedAt,
					sources: mergeModelsDevSources(
						previous?.sources,
						modelsDevSources(upstream, (id) => Object.keys(providers[id]?.chat ?? {}), modelsDevOwners),
						modelsDevOwners,
					),
				}
			: undefined,
	);

	// Print statistics
	const publishedChat = Object.values(providers).flatMap((catalog) => Object.values(catalog.chat));
	const totalModels = publishedChat.length;
	const reasoningModels = publishedChat.filter((model) => model.reasoning).length;

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
