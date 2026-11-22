import { CLOUDFLARE_WORKERS_AI_REST_BASE_URL } from "../../src/api/cloudflare.ts";
import { getOpenCodeBaseUrl } from "../../src/providers/opencode-endpoints.ts";
import type { ClassifierModel } from "../../src/types.ts";
import { catalogRequestOptions, modelsDev } from "./fetchers.ts";
import { withOpenAiLongContextPricing } from "./pricing.ts";
import { nonZeroOr } from "../../src/utils/non-zero.ts";

/** Classifier models: the models.dev decision catalog and the hand-listed OpenCode, Workers AI and OpenAI models. */

export async function loadModelsDevClassifierModels(): Promise<ClassifierModel<"typesafe-system-one">[]> {
	console.log("Fetching classifier models from models.dev API...");
	const data = await modelsDev.models({ ...catalogRequestOptions(), modelTypes: ["decision"] });
	const metadata = data["typesafe/jev-latest"];
	if (!metadata || metadata.type !== "decision") {
		throw new Error("models.dev did not return decision model typesafe/jev-latest");
	}
	return [
		{
			type: "classifier",
			id: "jev-latest",
			name: metadata.name,
			api: "typesafe-system-one",
			provider: "typesafe",
			baseUrl: "https://api.typesafe.ai/v1/",
			input: metadata.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
			// The canonical models.dev entry has no direct-provider pricing. System One reports token usage,
			// so classify() results carry token counts but price them at zero.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: nonZeroOr(64000, metadata.limit?.context),
		},
	];
}

// Workers AI has no unauthenticated catalog and models.dev does not list its
// System One models yet. Cloudflare publishes pricing only in the dashboard.
// https://developers.cloudflare.com/ai/models/typesafe/jev/
// OpenCode Zen serves Jev through its TypeSafe-compatible System One endpoint.
// Neither its /inference/v1/models listing nor models.dev carries metadata for it.
// https://opencode.ai/v2/docs/console/models/
export const OPENCODE_CLASSIFIER_MODELS: ClassifierModel<"typesafe-system-one">[] = [
	{
		type: "classifier",
		id: "jev-1.13",
		name: "Jev 1.13",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: getOpenCodeBaseUrl("opencode", "typesafe-system-one"),
		input: ["text"],
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
	{
		type: "classifier",
		id: "jev-1.13-free",
		name: "Jev 1.13 Free",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: getOpenCodeBaseUrl("opencode", "typesafe-system-one"),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
];

export const CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS: ClassifierModel<"cloudflare-workers-ai-system-one">[] = [
	// Cloudflare-hosted Clef decision models. They accept images, but classifier
	// contexts carry text or JSON state only, so the catalog advertises text.
	// Pricing: https://developers.cloudflare.com/workers-ai/models/clef/
	// and https://developers.cloudflare.com/workers-ai/models/clef-flash/
	{
		type: "classifier",
		id: "@cf/cloudflare/clef",
		name: "Clef",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text"],
		cost: { input: 0.24, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
	},
	{
		type: "classifier",
		id: "@cf/cloudflare/clef-flash",
		name: "Clef Flash",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text"],
		cost: { input: 0.09, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
	},
	{
		type: "classifier",
		id: "typesafe/jev",
		name: "Jev",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
];

// OpenAI Decisions API (public beta): gpt-6-luna is its only model. It bills input tokens only,
// with the same long-context multiplier as chat requests. Only API keys work: Sign in with ChatGPT
// tokens are rejected on /v1/decisions, and the Codex backend has no Decisions route.
// The endpoint rejects inputs above 922K tokens (the model's documented maximum input), but
// requests running longer than about five seconds, currently above roughly 600K input tokens,
// fail with a gateway timeout.
// https://developers.openai.com/api/docs/guides/decisions
export const OPENAI_CLASSIFIER_MODELS: ClassifierModel<"openai-decisions">[] = [
	{
		type: "classifier",
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-decisions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing({ input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 922000,
	},
];
