import type { AnyModel, Api, Model, ModelPromptCache } from "../../src/types.ts";

/** Prompt-cache lifetimes and image input limits. */

// Keep the generated default no less restrictive than coding-agent's historical
// image preprocessing. Provider limits can narrow this profile, but unknown
// providers retain the cache-safe 2000px / 4.5 MiB behavior.
const DEFAULT_IMAGE_RESIZE = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
} as const;

// Anthropic ephemeral entries have a hard five-minute lifetime; `ttl: "1h"`
// extends it to one hour. Only direct Anthropic is annotated so cache warming
// does not assume equivalent behavior through proxies.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const ANTHROPIC_PROMPT_CACHE: ModelPromptCache = { short: 300, long: 3600 };

export function applyPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		model.promptCache = ANTHROPIC_PROMPT_CACHE;
	}
	// Do not add OpenAI lifetimes yet. Before enabling warming for explicit
	// OpenAI caches, re-evaluate it using observed expiry, replay, and billing
	// behavior; a documented TTL alone does not establish full cache loss.
}

export function applyImageInputMetadata(model: AnyModel): void {
	if (!model.input.includes("image")) return;

	const providerLimits: AnyModel["inputLimits"] =
		model.provider === "anthropic"
			? {
					maxRequestBytes: 32 * 1024 * 1024,
					images: { maxPerRequest: model.type !== "image" && model.contextWindow === 200000 ? 100 : 600 },
				}
			: model.provider === "amazon-bedrock"
				? { images: { maxPerMessage: 20 } }
				: model.provider === "openai"
					? { maxRequestBytes: 512 * 1024 * 1024, images: { maxPerRequest: 1500 } }
					: model.provider === "google"
						? { maxRequestBytes: 20 * 1024 * 1024, images: { maxPerRequest: 3600 } }
						: undefined;
	const configuredImages = model.inputLimits?.images;
	model.inputLimits = {
		...providerLimits,
		...model.inputLimits,
		images: {
			...providerLimits?.images,
			...configuredImages,
			resize: { ...DEFAULT_IMAGE_RESIZE, ...configuredImages?.resize },
		},
	};
}
