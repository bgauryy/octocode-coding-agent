import { isBedrockInferenceHost } from "@octocodeai/octocode-ai/utils/provider-host";
import { type Api, isModelType, type Model, type Provider } from "@octocodeai/octocode-ai";

/**
 * The built-in model a `models.json` entry names, so a gateway or proxy entry that gives only `id` (and the provider's
 * `baseUrl` and `api`) gets the vendor's context window, output limit, thinking map, input types, prices, input limits
 * and compatibility. The entry's own fields win.
 */
export type KnownModelLookup = (api: Api, modelId: string, baseUrl?: string) => Model<Api> | undefined;

/** The built-in providers whose models an API's custom entries take their defaults from, first match wins. */
const VENDORS_BY_API: Partial<Record<string, readonly string[]>> = {
	"anthropic-messages": ["anthropic"],
	"openai-responses": ["openai"],
	"openai-completions": ["openai"],
	"azure-openai-responses": ["azure", "openai"],
	"google-generative-ai": ["google"],
	"google-vertex": ["google-vertex", "google"],
	"mistral-conversations": ["mistral"],
	"bedrock-converse-stream": ["amazon-bedrock"],
};

/**
 * One spelling for an id: lower case, without a gateway's `vendor/` prefix, `.` and `-` alike (`claude-opus-5.5` and
 * `claude-opus-5-5` name one model).
 */
export function normalizeModelId(modelId: string): string {
	const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
	return bare.toLowerCase().replaceAll(".", "-");
}

/** The model of `models` with this id: the exact spelling first, then the same normalized id. */
function matchById(models: readonly Model<Api>[], modelId: string): Model<Api> | undefined {
	const normalized = normalizeModelId(modelId);
	return (
		models.find((model) => model.id === modelId) ?? models.find((model) => normalizeModelId(model.id) === normalized)
	);
}

/** Where vendor providers are found by id: the built-in map, or a live runtime's `getProvider`. */
type VendorProviders = Pick<ReadonlyMap<string, Provider>, "get">;

/** The chat models of one vendor provider, of any API. */
function chatModels(provider: Provider): Model<Api>[] {
	return (provider.getAllModels?.() ?? provider.getModels()).filter((model) => isModelType(model, "chat"));
}

/**
 * The vendor models a custom entry of `api` can name by id, first vendor first: what a gateway template offers, so the
 * user picks ids and each id inherits that model's metadata when `models.json` loads.
 */
export function vendorChatModels(providers: VendorProviders, api: Api): Model<Api>[] {
	const seen = new Set<string>();
	const models: Model<Api>[] = [];
	for (const vendor of VENDORS_BY_API[api] ?? []) {
		const provider = providers.get(vendor);
		if (!provider) continue;
		for (const model of chatModels(provider)) {
			if (model.api !== api || seen.has(normalizeModelId(model.id))) continue;
			seen.add(normalizeModelId(model.id));
			models.push(model);
		}
	}
	return models;
}

/** Labs whose models a gateway often serves through another API (a LiteLLM proxy speaks `openai-completions`). */
const CROSS_API_VENDORS = ["anthropic", "openai", "google", "mistral", "deepseek", "xai"] as const;

/**
 * The same model on another API, reduced to what does not depend on the API: context window, output limit, reasoning,
 * input types, input limits and prices. Request compatibility, the thinking map, sampling and cache lifetimes belong
 * to the API the vendor serves it on, so they stay behind.
 */
function crossApiModel(providers: VendorProviders, api: Api, modelId: string): Model<Api> | undefined {
	for (const vendor of CROSS_API_VENDORS) {
		const provider = providers.get(vendor);
		const match = provider ? matchById(chatModels(provider), modelId) : undefined;
		if (!match) continue;
		const {
			compat: _compat,
			thinkingLevelMap: _thinking,
			promptCache: _promptCache,
			samplingParams: _sampling,
			samplingParamsByThinkingLevel: _samplingByLevel,
			...neutral
		} = match;
		return { ...neutral, api };
	}
	return undefined;
}

/**
 * Look up built-in models: the same model on the same API of the API's vendor first (everything carries), else the same
 * model on another API (only API-independent fields). Reads the providers on every call, so refreshed catalogs apply.
 */
export function knownModelLookup(builtins: VendorProviders): KnownModelLookup {
	return (api, modelId, baseUrl) => {
		const bedrockOpenAI =
			(api === "openai-completions" || api === "openai-responses") && baseUrl && isBedrockInferenceHost(baseUrl);
		if (bedrockOpenAI || api === "bedrock-converse-stream") {
			const provider = builtins.get("amazon-bedrock");
			const models = provider && chatModels(provider);
			let match = models?.find((model) => model.id === modelId);
			// AWS lists India and US Kimi profiles at the same regional rates. Older catalogs list only US.
			if (!match && /^in\.moonshotai\.kimi-k3(?:\.1)?$/.test(modelId)) {
				const us = models?.find((model) => model.id === `us.${modelId.slice(3)}`);
				if (us) match = { ...us, id: modelId, name: modelId };
			}
			if (match) {
				if (api === match.api) return match;
				const { compat: _wire, headers: _headers, promptCache: _cache, ...metadata } = match;
				return { ...metadata, api };
			}
		}
		for (const vendor of VENDORS_BY_API[api] ?? []) {
			const provider = builtins.get(vendor);
			if (!provider) continue;
			const known = matchById(
				chatModels(provider).filter((model) => model.api === api),
				modelId,
			);
			if (known) return known;
		}
		return crossApiModel(builtins, api, modelId);
	};
}
