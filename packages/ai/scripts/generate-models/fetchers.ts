import { Models } from "@opencode-ai/models";
import type { ClassifierModel, Model } from "../../src/types.ts";
import { getAiGatewayCost } from "../ai-gateway-pricing.ts";
import { buildOpenRouterCatalog, type OpenRouterCatalog, type OpenRouterModelListItem } from "../openrouter-catalog.ts";
import {
	AI_GATEWAY_BASE_URL,
	AI_GATEWAY_MODELS_URL,
	AI_GATEWAY_TYPESAFE_BASE_URL,
	NVIDIA_BASE_URL,
} from "./constants.ts";
import { roundCost } from "./pricing.ts";
import type { AiGatewayModel, NvidiaNimModelListItem } from "./types.ts";
import { nonZeroOr } from "../../src/utils/non-zero.ts";

/** Fetchers for the NVIDIA NIM, OpenRouter and Vercel AI Gateway catalogs. */

const CATALOG_FETCH_TIMEOUT_MS = 60_000;

export const modelsDev = Models.make();

export function catalogRequestOptions(): { signal: AbortSignal } {
	return { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) };
}

/** GET an upstream catalog; a stalled server fails the run after a minute instead of undici's five-minute defaults. */
function fetchCatalog(url: string): Promise<Response> {
	return fetch(url, catalogRequestOptions());
}

async function fetchCatalogRows<T>(source: string, url: string): Promise<T[]> {
	const response = await fetchCatalog(url);
	if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);
	const body = (await response.json()) as { data?: unknown } | null;
	if (!Array.isArray(body?.data) || !body.data.length) throw new Error(`${source} returned no catalog rows`);
	return body.data as T[];
}

export function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

export async function fetchNvidiaNimModelIds(): Promise<Map<string, string>> {
	console.log("Fetching models from NVIDIA NIM API...");
	const rows = await fetchCatalogRows<NvidiaNimModelListItem>("NVIDIA NIM", `${NVIDIA_BASE_URL}/models`);
	const modelIds = new Map<string, string>();

	for (const model of rows) {
		modelIds.set(model.id, model.id);
		modelIds.set(normalizeNvidiaModelId(model.id), model.id);
	}

	console.log(`Fetched ${rows.length} model IDs from NVIDIA NIM`);
	return modelIds;
}

function fetchOpenRouterList(query: string): Promise<OpenRouterModelListItem[]> {
	return fetchCatalogRows(`OpenRouter /models${query}`, `https://openrouter.ai/api/v1/models${query}`);
}

export async function fetchOpenRouterModels(): Promise<OpenRouterCatalog> {
	console.log("Fetching models from OpenRouter API...");
	const [listed, imageListed, decisionListed] = await Promise.all([
		fetchOpenRouterList(""),
		fetchOpenRouterList("?output_modalities=image"),
		fetchOpenRouterList("?output_modalities=decisions"),
	]);
	const catalog = buildOpenRouterCatalog(listed, imageListed, decisionListed);
	console.log(
		`Selected from ${listed.length} base, ${imageListed.length} image, and ${decisionListed.length} decision listings: ${catalog.chat.length} tool-capable, ${catalog.images.length} image, and ${catalog.classifiers.length} classifier models from OpenRouter`,
	);
	for (const [kind, rows] of Object.entries(catalog)) {
		if (!rows.length) throw new Error(`OpenRouter returned no usable ${kind} models`);
	}
	return catalog;
}

export async function fetchAiGatewayModels(): Promise<{
	chat: Model<any>[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}> {
	console.log("Fetching models from Vercel AI Gateway API...");
	const items = await fetchCatalogRows<AiGatewayModel>("Vercel AI Gateway", `${AI_GATEWAY_MODELS_URL}/models`);
	const models: Model<any>[] = [];
	const classifiers: ClassifierModel<"typesafe-system-one">[] = [];

	const toNumber = (value: string | number | undefined): number => {
		if (typeof value === "number") {
			return Number.isFinite(value) ? value : 0;
		}
		const parsed = parseFloat(value ?? "0");
		return Number.isFinite(parsed) ? parsed : 0;
	};

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
				contextWindow: nonZeroOr(4096, model.context_window),
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
			contextWindow: nonZeroOr(4096, model.context_window),
			maxTokens: nonZeroOr(4096, model.max_tokens),
		});
	}

	console.log(
		`Selected ${models.length} tool-capable and ${classifiers.length} classifier models from ${items.length} Vercel AI Gateway listings`,
	);
	if (!models.length || !classifiers.length)
		throw new Error("Vercel AI Gateway returned an empty chat or classifier catalog");
	return { chat: models, classifiers };
}
