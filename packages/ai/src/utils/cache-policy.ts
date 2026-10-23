import type { CacheRetention, ProviderEnv, StreamOptions } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

export const INSTRUCTION_CACHE_RETENTION_ENV = "OCTOCODE_INSTRUCTION_CACHE_RETENTION";
export const CACHE_RETENTION_VALUES = ["none", "short", "long"] as const;
export type CachePreferences = Pick<StreamOptions, "cacheRetention" | "instructionCacheRetention">;
export interface CachePreferenceLayer {
	source: string;
	values: CachePreferences;
}

function parseCacheRetention(value: unknown, field: string): CacheRetention | undefined {
	if (value === undefined) return undefined;
	if (value === "none" || value === "short" || value === "long") return value;
	throw new Error(`Invalid ${field}: expected none, short, or long`);
}

/** Layers are ordered from lowest to highest priority; a legacy history value controls both layers. */
export function mergeCachePreferences(layers: readonly CachePreferenceLayer[]) {
	const options: CachePreferences = {};
	const sources: Partial<Record<keyof CachePreferences, string>> = {};
	for (const { source, values } of layers) {
		const history = parseCacheRetention(values.cacheRetention, `${source}.cacheRetention`);
		const instructions = parseCacheRetention(values.instructionCacheRetention, `${source}.instructionCacheRetention`);
		if (history !== undefined) {
			options.cacheRetention = history;
			options.instructionCacheRetention = history;
			sources.cacheRetention = source;
			sources.instructionCacheRetention = source;
		}
		if (instructions !== undefined) {
			options.instructionCacheRetention = instructions;
			sources.instructionCacheRetention = source;
		}
	}
	if (options.cacheRetention === "none") {
		options.instructionCacheRetention = "none";
		sources.instructionCacheRetention = sources.cacheRetention;
	}
	// Instructions come before history, and a cache breakpoint with a longer lifetime cannot follow a shorter one: short
	// instructions with long history would fail every request, so history is capped here, where the choice is made.
	if (options.instructionCacheRetention === "short" && options.cacheRetention === "long") {
		options.cacheRetention = "short";
		sources.cacheRetention = `${sources.cacheRetention} (capped by instruction retention)`;
	}
	return { options, sources };
}

export function cacheEnvironmentPreferences(env?: ProviderEnv): CachePreferences {
	return {
		cacheRetention: parseCacheRetention(
			getProviderEnvValue("OCTOCODE_CACHE_RETENTION", env),
			"OCTOCODE_CACHE_RETENTION",
		),
		instructionCacheRetention: parseCacheRetention(
			getProviderEnvValue(INSTRUCTION_CACHE_RETENTION_ENV, env),
			INSTRUCTION_CACHE_RETENTION_ENV,
		),
	};
}

export function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention !== undefined) return cacheRetention;
	const value = getProviderEnvValue("OCTOCODE_CACHE_RETENTION", env);
	return value === "long" || value === "none" ? value : "short";
}

/** Explicit Pi retention still controls the whole prompt unless a separate instruction preference is supplied. */
export function resolveInstructionCacheRetention(options?: StreamOptions): CacheRetention | undefined {
	const history = resolveCacheRetention(options?.cacheRetention, options?.env);
	if (history === "none") return "none";
	if (options?.instructionCacheRetention !== undefined) return options.instructionCacheRetention;
	if (options?.cacheRetention !== undefined) return undefined;
	const value = getProviderEnvValue(INSTRUCTION_CACHE_RETENTION_ENV, options?.env);
	return value === "long" || value === "short" || value === "none" ? value : undefined;
}
