import type { Api, Model, OpenAIResponsesCompat } from "../types.ts";
import {
	AZURE_EXTENDED_RETENTION_MODELS,
	AZURE_INSTRUCTION_BREAKPOINT_MODELS,
	OPENAI_EXPLICIT_CACHE_MODELS,
	OPENAI_EXTENDED_RETENTION_MODELS,
	OPENROUTER_EXPLICIT_MARKER_MODELS,
} from "./cache-capability-data.ts";
import { matchesHost } from "./provider-host.ts";

/** Base id without a trailing date suffix (`-2026-11-08` or `-20261108`), so a dated snapshot resolves like its base. */
export function baseModelId(id: string): string {
	return id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

/** Whether `id` is listed in `bases` or is a dated snapshot of a listed id. */
function listed(id: string, bases: ReadonlySet<string>): boolean {
	return bases.has(id) || bases.has(baseModelId(id));
}

/** Cache compat the data in `cache-capability-data.ts` declares for a model; empty when it declares none. */
function declaredCacheCompat(model: Model<Api>): Record<string, unknown> {
	const { id } = model;
	switch (model.api) {
		case "openai-responses":
			if (new URL(model.baseUrl).origin !== "https://api.openai.com") return {};
			if (listed(id, OPENAI_EXPLICIT_CACHE_MODELS))
				return { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true };
			return listed(id, OPENAI_EXTENDED_RETENTION_MODELS) ? { supportsLongCacheRetention: true } : {};
		case "openai-completions":
			if (model.provider === "openrouter")
				return OPENROUTER_EXPLICIT_MARKER_MODELS.has(id)
					? { cacheControlFormat: "anthropic", supportsLongCacheRetention: false }
					: {};
			if (!matchesHost(model.baseUrl, "api.openai.com")) return {};
			// Chat Completions takes GPT-5.6 and later only with the default 30m TTL: no long-retention field.
			if (listed(id, OPENAI_EXPLICIT_CACHE_MODELS)) return { supportsExplicitPromptCacheMode: true };
			return listed(id, OPENAI_EXTENDED_RETENTION_MODELS) ? { supportsLongCacheRetention: true } : {};
		case "azure-openai-responses":
			return {
				...(listed(id, AZURE_INSTRUCTION_BREAKPOINT_MODELS) ? { supportsInstructionBreakpoints: true } : {}),
				...(listed(id, AZURE_EXTENDED_RETENTION_MODELS) ? { supportsLongCacheRetention: true } : {}),
			};
		default:
			return {};
	}
}

/**
 * Fill missing cache compat from the documented per-model data, without deriving protocol support from pricing.
 * Explicit `model.compat` values win. Applied when the catalog is generated and loaded.
 */
export function withCacheCapabilities<T extends Model<Api>>(model: T): T {
	let declared: Record<string, unknown>;
	try {
		declared = declaredCacheCompat(model);
	} catch {
		return model;
	}
	if (Object.keys(declared).length === 0) return model;
	return { ...model, compat: { ...declared, ...model.compat } };
}

function normalizedEndpoint(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
	} catch {
		return undefined;
	}
}

/** Whether two base URLs name one endpoint: same scheme, host (any case) and port, same path up to a trailing slash. */
function sameEndpoint(a: string, b: string): boolean {
	if (a === b) return true;
	const left = normalizedEndpoint(a);
	return left !== undefined && left === normalizedEndpoint(b);
}

/** Direct-provider capabilities must be re-declared when a configured endpoint changes. */
export function withCacheEndpoint<T extends Model<Api>>(model: T, baseUrl: string): T {
	if (sameEndpoint(model.baseUrl, baseUrl)) return model;
	if (model.provider !== "openai" && model.provider !== "anthropic") return { ...model, baseUrl };
	const compat = { ...model.compat, supportsLongCacheRetention: false };
	if (model.api === "openai-responses") (compat as OpenAIResponsesCompat).supportsExplicitPromptCacheMode = false;
	return { ...model, baseUrl, compat, promptCache: undefined };
}
