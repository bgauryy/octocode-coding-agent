import type { ModelsDevProviderSource, ModelsDevSources } from "../../src/catalog/models-dev-sources.ts";
import type { KnownProvider } from "../../src/types/ids.ts";
import {
	BEDROCK_END_OF_LIFE_MODEL_IDS,
	BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS,
	MINIMAX_HIDDEN_MODEL_IDS,
	MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS,
	OPENCODE_EXCLUDED_MODEL_IDS,
	QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS,
	XAI_BUILTIN_EXCLUDED_MODEL_IDS,
} from "./constants.ts";
import type { ModelsDevCatalog } from "./types.ts";

/**
 * The models.dev listing each built-in provider is built from, recorded in the data manifest (`modelsDevSources`) so the
 * runtime catalog update reads the same listing and never adds an id the generator left out.
 *
 * Only providers whose bundled model ids are the listing's own ids are here. Left out, so they get no runtime price
 * changes or added models: `cloudflare-ai-gateway` (ids are rewritten), `nvidia` (ids come from NVIDIA's live list),
 * `qwen-token-plan-individual` (a fixed subset), and providers not built from models.dev.
 */
const LISTINGS: Partial<Record<KnownProvider, { listing: string | readonly string[]; prices?: string }>> = {
	"amazon-bedrock": { listing: "amazon-bedrock" },
	anthropic: { listing: "anthropic" },
	baseten: { listing: "baseten" },
	cerebras: { listing: "cerebras" },
	"cloudflare-workers-ai": { listing: "cloudflare-workers-ai" },
	fireworks: { listing: "fireworks-ai" },
	"github-copilot": { listing: "github-copilot" },
	google: { listing: "google" },
	"google-vertex": { listing: "google-vertex" },
	groq: { listing: "groq" },
	huggingface: { listing: "huggingface" },
	"kimi-coding": { listing: "kimi-code-plan-global" },
	meta: { listing: "meta" },
	minimax: { listing: "minimax" },
	"minimax-cn": { listing: "minimax-cn" },
	mistral: { listing: "mistral" },
	moonshotai: { listing: "moonshotai" },
	"moonshotai-cn": { listing: "moonshotai-cn" },
	openai: { listing: "openai" },
	opencode: { listing: "opencode" },
	"opencode-go": { listing: "opencode-go" },
	"qwen-token-plan": { listing: "alibaba-token-plan" },
	"qwen-token-plan-cn": { listing: "alibaba-token-plan-cn" },
	// The generator reads the first of these models.dev lists.
	together: { listing: ["together", "togetherai", "together-ai"] },
	xai: { listing: "xai" },
	xiaomi: { listing: "xiaomi" },
	"xiaomi-token-plan-ams": { listing: "xiaomi-token-plan-ams" },
	"xiaomi-token-plan-cn": { listing: "xiaomi-token-plan-cn" },
	"xiaomi-token-plan-sgp": { listing: "xiaomi-token-plan-sgp" },
	// The coding plans list 0; the generator prices each model from the pay-as-you-go entry of the same id.
	zai: { listing: "zai-coding-plan", prices: "zai" },
	"zai-coding-cn": { listing: "zhipuai-coding-plan", prices: "zai" },
};

/** Ids the generator never builds for a provider, listed or not yet: kept out even when models.dev adds them later. */
const ALWAYS_EXCLUDED: Partial<Record<KnownProvider, ReadonlySet<string>>> = {
	"amazon-bedrock": new Set([...BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS, ...BEDROCK_END_OF_LIFE_MODEL_IDS]),
	minimax: MINIMAX_HIDDEN_MODEL_IDS,
	"minimax-cn": MINIMAX_HIDDEN_MODEL_IDS,
	openai: MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS,
	opencode: OPENCODE_EXCLUDED_MODEL_IDS,
	"opencode-go": OPENCODE_EXCLUDED_MODEL_IDS,
	"qwen-token-plan": QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS,
	"qwen-token-plan-cn": QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS,
	xai: XAI_BUILTIN_EXCLUDED_MODEL_IDS,
};

/**
 * Each provider's models.dev source for the manifest, for the `providers` this run built: the listing, where prices
 * come from, and every id the listing has (standard models) that the built catalog leaves out, plus `ALWAYS_EXCLUDED`.
 * A provider whose listing is missing from `data` is left out (its runtime updates stay off).
 */
export function modelsDevSources(
	data: ModelsDevCatalog,
	builtIds: (provider: string) => Iterable<string>,
	providers: Iterable<string>,
): Record<string, ModelsDevProviderSource> {
	const sources: Record<string, ModelsDevProviderSource> = {};
	for (const provider of providers) {
		const entry = LISTINGS[provider as KnownProvider];
		if (!entry) continue;
		const listing = [entry.listing].flat().find((key) => data[key]?.models !== undefined);
		if (!listing) continue;
		const built = new Set(builtIds(provider));
		const listed = Object.entries(data[listing]?.models ?? {})
			.filter(([, model]) => !model.type)
			.map(([id]) => id);
		const excluded = new Set([
			...listed.filter((id) => !built.has(id)),
			...(ALWAYS_EXCLUDED[provider as KnownProvider] ?? []),
		]);
		sources[provider] = {
			listing,
			...(entry.prices ? { prices: entry.prices } : {}),
			excluded: [...excluded].sort(),
		};
	}
	return sources;
}

/** `next` over `previous`: a run that rebuilt only some providers keeps the others' recorded sources. */
export function mergeModelsDevSources(
	previous: ModelsDevSources | undefined,
	next: Readonly<Record<string, ModelsDevProviderSource>>,
	rebuilt: Iterable<string>,
): ModelsDevSources {
	const replaced = new Set(rebuilt);
	return {
		...Object.fromEntries(Object.entries(previous ?? {}).filter(([provider]) => !replaced.has(provider))),
		...next,
	};
}
