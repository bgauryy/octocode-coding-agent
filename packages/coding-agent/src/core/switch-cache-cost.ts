import { calculateCost, type AssistantMessage, type Model } from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";

type Priced = Pick<Model<any>, "provider" | "id" | "cost"> & { api?: string };

/**
 * One line telling what switching models rewrites: the cached prefix of the session's last request, priced at the
 * target's cache-write rate (its input rate when it has no write rate). Empty when the cache key stays the same (same
 * provider and model) or the last request cached nothing.
 */
export function switchCacheNotice(
	last: Pick<AssistantMessage, "usage"> | undefined,
	current: Pick<Priced, "provider" | "id"> | undefined,
	target: Priced & { id: string },
): string | undefined {
	if (!last || !current) return undefined;
	if (current.provider === target.provider && current.id === target.id) return undefined;
	const tokens = last.usage.cacheRead + last.usage.cacheWrite;
	if (tokens <= 0) return undefined;
	const priced = { ...createEmptyUsage(), cacheWrite: tokens };
	let dollars = calculateCost(target as Model<any>, priced).cacheWrite;
	if (dollars === 0) dollars = calculateCost(target as Model<any>, { ...createEmptyUsage(), input: tokens }).input;
	const size = tokens < 1000 ? `${tokens}` : `${Math.round(tokens / 1000)}k`;
	const price = dollars > 0 && dollars < 0.005 ? "<$0.01" : `$${dollars.toFixed(2)}`;
	return `switching rewrites ~${size} cached tokens (~${price} at ${target.id}'s cache-write price)`;
}
