import type { ClassifierModel, Model } from "../../src/types.ts";
import { getAiGatewayCost } from "../ai-gateway-pricing.ts";
import { buildOpenRouterCatalog, type OpenRouterCatalog, type OpenRouterModelListItem } from "../openrouter-catalog.ts";
import {
	AI_GATEWAY_BASE_URL,
	AI_GATEWAY_MODELS_URL,
	AI_GATEWAY_TYPESAFE_BASE_URL,
	NVIDIA_BASE_URL,
} from "./constants.ts";
import { generatorOptions } from "./options.ts";
import { roundCost } from "./pricing.ts";
import type { AiGatewayModel, NvidiaNimModelListItem } from "./types.ts";

/** Fetchers for the NVIDIA NIM, OpenRouter and Vercel AI Gateway catalogs. */

export function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

export async function fetchNvidiaNimModelIds(): Promise<Map<string, string>> {
	try {
		console.log("Fetching models from NVIDIA NIM API...");
		const response = await fetch(`${NVIDIA_BASE_URL}/models`);
		if (!response.ok) throw new Error(`NVIDIA NIM API returned ${response.status}`);
		const data = (await response.json()) as { data?: NvidiaNimModelListItem[] };
		const modelIds = new Map<string, string>();

		for (const model of data.data ?? []) {
			modelIds.set(model.id, model.id);
			modelIds.set(normalizeNvidiaModelId(model.id), model.id);
		}

		console.log(`Fetched ${data.data?.length ?? 0} model IDs from NVIDIA NIM`);
		return modelIds;
	} catch (error) {
		console.error("Failed to fetch NVIDIA NIM models:", error);
		if (generatorOptions.strict) throw error;
		return new Map();
	}
}

async function fetchOpenRouterList(query: string): Promise<OpenRouterModelListItem[]> {
	const response = await fetch(`https://openrouter.ai/api/v1/models${query}`);
	if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
	const data = (await response.json()) as { data?: OpenRouterModelListItem[] };
	return data.data ?? [];
}

export async function fetchOpenRouterModels(): Promise<OpenRouterCatalog> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const [listed, imageListed, decisionListed] = await Promise.all([
			fetchOpenRouterList(""),
			fetchOpenRouterList("?output_modalities=image"),
			fetchOpenRouterList("?output_modalities=decisions"),
		]);
		const catalog = buildOpenRouterCatalog(listed, imageListed, decisionListed);
		console.log(
			`Fetched ${catalog.chat.length} tool-capable, ${catalog.images.length} image, and ${catalog.classifiers.length} classifier models from OpenRouter`,
		);
		if (generatorOptions.strict && catalog.images.length === 0) {
			throw new Error("OpenRouter API returned no usable image models");
		}
		return catalog;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], images: [], classifiers: [] };
	}
}

export async function fetchAiGatewayModels(): Promise<{
	chat: Model<any>[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
		const data = await response.json();
		const models: Model<any>[] = [];
		const classifiers: ClassifierModel<"typesafe-system-one">[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			// Evaluation models such as TypeSafe's Jev are served through the
			// TypeSafe-compatible System One endpoint.
			if (model.type === "evaluation") {
				classifiers.push({
					type: "classifier",
					id: model.id,
					name: model.name || model.id,
					api: "typesafe-system-one",
					provider: "vercel-ai-gateway",
					baseUrl: AI_GATEWAY_TYPESAFE_BASE_URL,
					input: ["text"],
					cost: {
						input: roundCost(toNumber(model.pricing?.input) * 1_000_000),
						output: roundCost(toNumber(model.pricing?.output) * 1_000_000),
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: model.context_window || 4096,
				});
				continue;
			}
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				reasoning: tags.includes("reasoning"),
				input,
				compat: { allowEmptySignature: true },
				cost: getAiGatewayCost(model.pricing),
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(
			`Fetched ${models.length} tool-capable and ${classifiers.length} classifier models from Vercel AI Gateway`,
		);
		return { chat: models, classifiers };
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], classifiers: [] };
	}
}
