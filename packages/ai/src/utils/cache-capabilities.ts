import type { Api, Model, OpenAIResponsesCompat } from "../types.ts";
import type { CacheFlagTable, ModelCacheFlags } from "./cache-capability-data.ts";
import { CACHE_CAPABILITY_FLAGS } from "./cache-capability-flags.generated.ts";
import { hasProviderProfile } from "./provider-profile.ts";

/** Base id without a trailing date suffix (`-2026-11-08` or `-20261108`), so a dated snapshot resolves like its base. */
export function baseModelId(id: string): string {
	return id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

/** Flags the table holds for `id` or, for a dated snapshot, for its base id. */
function flagsFor(table: Readonly<Record<string, ModelCacheFlags>>, id: string): ModelCacheFlags {
	const own = (key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);
	return own(id) ?? own(baseModelId(id)) ?? {};
}

/** Cache compat the flag table declares for a model; empty when it declares none. */
function declaredCacheCompat(model: Model<Api>, table: CacheFlagTable): Record<string, unknown> {
	const { id } = model;
	switch (model.api) {
		case "openai-responses": {
			if (!hasProviderProfile(model, "openai", "host")) return {};
			const flags = flagsFor(table.openai, id);
			if (flags.explicitMode) return { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true };
			return flags.longRetention ? { supportsLongCacheRetention: true } : {};
		}
		case "openai-completions": {
			if (hasProviderProfile(model, "openrouter"))
				// OpenRouter excludes snapshot endpoints, so its ids match exactly.
				return Object.hasOwn(table.openrouter, id) && table.openrouter[id].explicitMarkers
					? { cacheControlFormat: "anthropic", supportsLongCacheRetention: false }
					: {};
			if (!hasProviderProfile(model, "openai", "host")) return {};
			const flags = flagsFor(table.openai, id);
			// Chat Completions takes GPT-5.6 and later only with the default 30m TTL: no long-retention field.
			if (flags.explicitMode) return { supportsExplicitPromptCacheMode: true };
			return flags.longRetention ? { supportsLongCacheRetention: true } : {};
		}
		case "azure-openai-responses": {
			const flags = flagsFor(table.azure, id);
			return {
				...(flags.instructionBreakpoints ? { supportsInstructionBreakpoints: true } : {}),
				...(flags.longRetention ? { supportsLongCacheRetention: true } : {}),
			};
		}
		default:
			return {};
	}
}

/**
 * Fill missing cache compat from a flag table, without deriving protocol support from pricing.
 * Explicit `model.compat` values win. The model generator applies it to the catalog with the table it just built.
 */
export function withCacheFlags<T extends Model<Api>>(model: T, table: CacheFlagTable): T {
	const declared = declaredCacheCompat(model, table);
	if (Object.keys(declared).length === 0) return model;
	return { ...model, compat: { ...declared, ...model.compat } };
}

/** `withCacheFlags` with the generated table: the catalog and custom models get the documented cache compat. */
export function withCacheCapabilities<T extends Model<Api>>(model: T): T {
	return withCacheFlags(model, CACHE_CAPABILITY_FLAGS);
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
