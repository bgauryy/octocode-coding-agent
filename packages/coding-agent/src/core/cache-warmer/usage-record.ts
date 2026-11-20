import {
	type Api,
	type AssistantMessage,
	type CacheMechanism,
	type Model,
	resolveModelCapabilities,
	type ProviderEnv,
} from "@octocodeai/octocode-ai";
import { isCacheTtlControllable } from "@octocodeai/octocode-ai/utils/cache-policy";
import { getToolLoadingMode, type ToolLoadingMode } from "@octocodeai/octocode-ai/utils/tool-loading";

/** The cache tiers the adapter resolved for a model: what a request may write, not the model's price list. */
interface ResolvedCacheTier {
	mechanism: CacheMechanism;
	/** Short and long lifetimes as `5m`, `30m`, `1h`, `12h`, `24h`; absent where the adapter sends none. */
	short?: string;
	long?: string;
	/** The request names and refreshes its lifetime (`isCacheTtlControllable`). */
	controllable: boolean;
}

/** One provider request, normalized across providers (RFC F7). Token fields are disjoint; `cost` is US dollars. */
export interface UsageRecord {
	provider: string;
	api: Api;
	model: string;
	/** How a tool change reaches this API (`changes`, `additions`, `none`); undefined without the model. */
	transport?: ToolLoadingMode;
	tier?: ResolvedCacheTier;
	input: number;
	cacheRead: number;
	output: number;
	/** Cache writes in total and by lifetime; writes the provider did not split are filed under the short tier. */
	cacheWrite: { total: number; byTtl: Record<string, number> };
	cost: number;
	/** The provider's final count never arrived: the figures are a floor. */
	lowerBound: boolean;
}

/** A lifetime in seconds as the providers spell it: `5m`, `1h`, `24h`. */
export function formatTtl(seconds: number): string {
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

/** The tiers the adapter sends for `model` (`resolveModelCapabilities`). */
function resolveCacheTier(model: Model<Api>, env?: ProviderEnv): ResolvedCacheTier {
	const { mechanism, lifetimes, longUpTo } = resolveModelCapabilities(model, env).cache;
	// The tier as the request names it (`24h`), not the shorter lifetime planning assumes for it.
	const long = longUpTo ?? lifetimes.long;
	return {
		mechanism,
		...(lifetimes.short !== undefined ? { short: formatTtl(lifetimes.short) } : {}),
		...(long !== undefined ? { long: formatTtl(long) } : {}),
		controllable: isCacheTtlControllable(mechanism),
	};
}

/** The normalized record of one assistant response; `model` is the model that served it, when known. */
export function usageRecord(message: AssistantMessage, model?: Model<Api>): UsageRecord {
	const usage = message.usage;
	const tier = model ? resolveCacheTier(model) : undefined;
	const split: Record<string, number> = {};
	const add = (ttl: string, tokens: number | undefined) => {
		if (tokens !== undefined && tokens > 0) split[ttl] = (split[ttl] ?? 0) + tokens;
	};
	add("1h", usage.cacheWrite1h);
	add("12h", usage.cacheWrite12h);
	add("30m", usage.cacheWrite30m);
	const labelled = Object.values(split).reduce((sum, tokens) => sum + tokens, 0);
	add(tier?.short ?? "short", Math.max(0, usage.cacheWrite - labelled));
	return {
		provider: message.provider,
		api: message.api,
		model: message.model,
		...(model ? { transport: getToolLoadingMode(model) } : {}),
		...(tier ? { tier } : {}),
		input: usage.input,
		cacheRead: usage.cacheRead,
		output: usage.output,
		cacheWrite: { total: usage.cacheWrite, byTtl: split },
		cost: usage.cost.total,
		lowerBound: usage.lowerBound === true,
	};
}
