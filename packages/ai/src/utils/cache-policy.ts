import type { CacheRetention, ProviderEnv, StreamOptions } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

export const INSTRUCTION_CACHE_RETENTION_ENV = "OCTOCODE_INSTRUCTION_CACHE_RETENTION";
export const PROMPT_CACHE_KEY_ENV = "OCTOCODE_PROMPT_CACHE_KEY";

/** Cache affinity is independent of transport identity, so sibling sessions can reuse their common prefix. */
export function resolvePromptCacheKey(
	options?: Pick<StreamOptions, "promptCacheKey" | "sessionId" | "env">,
): string | undefined {
	return options?.promptCacheKey ?? getProviderEnvValue(PROMPT_CACHE_KEY_ENV, options?.env) ?? options?.sessionId;
}
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
	// Short instructions with long history are kept as configured: whether a longer-lived breakpoint may follow a shorter
	// one is the provider's rule, so the adapters that have it (Anthropic-style markers) cap history themselves.
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

/**
 * Retention of the instruction breakpoint (system prompt and tools) and of the history breakpoint, for adapters that
 * place both. Instructions default to the history retention. The pair is returned as requested: an adapter whose
 * provider requires longer-lived breakpoints first (Anthropic, Bedrock) caps long history behind short instructions.
 */
export function resolveLayeredCacheRetention(options?: StreamOptions): {
	history: CacheRetention;
	instructions: CacheRetention;
} {
	const history = resolveCacheRetention(options?.cacheRetention, options?.env);
	const instructions = resolveInstructionCacheRetention(options) ?? history;
	return { history, instructions };
}

/**
 * The instruction retention, or undefined to follow the history's. Explicit `cacheRetention` controls the whole prompt
 * unless a separate instruction preference is supplied, and history `none` turns off the instruction breakpoint too,
 * whatever instruction preference is supplied, unless the request also sets `keepInstructionCache` (a summary whose
 * history is cold while the longer-lived instruction entry is not).
 */
export function resolveInstructionCacheRetention(options?: StreamOptions): CacheRetention | undefined {
	const history = resolveCacheRetention(options?.cacheRetention, options?.env);
	if (history === "none") {
		return options?.keepInstructionCache ? (options.instructionCacheRetention ?? "none") : "none";
	}
	if (options?.instructionCacheRetention !== undefined) return options.instructionCacheRetention;
	if (options?.cacheRetention !== undefined) return undefined;
	const value = getProviderEnvValue(INSTRUCTION_CACHE_RETENTION_ENV, options?.env);
	return value === "long" || value === "short" || value === "none" ? value : undefined;
}
