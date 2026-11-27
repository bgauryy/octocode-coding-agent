import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { num, str, type Prepared } from "./entries.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** What an Anthropic entry lives without a `ttl`: the default ephemeral tier. */
const ANTHROPIC_DEFAULT = 5 * MINUTE;

/** Anthropic or Bedrock, by provider name or by protocol, so a custom provider that speaks either API counts too. */
function anthropicLike(message: Record<string, unknown>): boolean {
	return /anthropic|bedrock/i.test(String(message.provider)) || /^(anthropic|bedrock)-/.test(String(message.api));
}

/** Which cached prefix a lifetime is asked for: the growing conversation, or the tools and system blocks before it. */
export type CacheTier = "history" | "instructions";

const durationMs = (ttl: string): number | undefined => {
	const match = /^(\d+)([mh])$/.exec(ttl);
	return match ? Number(match[1]) * (match[2] === "h" ? HOUR : MINUTE) : undefined;
};

/**
 * The lifetime the request's own breakpoints name for `tier` (`RequestLayer.ttl`, recorded per breakpoint): the last
 * breakpoint on a message for the history, the last on the tools or a system block for the instructions. Undefined
 * when the trace records no such breakpoint TTL (an older trace, or a history cached without a marker of its own).
 */
function breakpointLifetime(message: Record<string, unknown>, tier: CacheTier): number | undefined {
	const layers = asRecord(message.requestTrace).layers;
	if (!Array.isArray(layers)) return undefined;
	let found: number | undefined;
	for (const raw of layers) {
		const layer = asRecord(raw);
		if (layer.breakpoint !== true || typeof layer.ttl !== "string") continue;
		if ((layer.kind === "message") === (tier === "history")) found = durationMs(layer.ttl) ?? found;
	}
	return found;
}

/**
 * The lifetime one request's record names for `tier`, or undefined when it names none. Each breakpoint's recorded TTL
 * decides first. Without one: a 12h write (OpenAI GPT-5.6 and later), a 1h write (Anthropic, Bedrock), or a TTL in the
 * recorded `requestTrace.cacheMode` (`ephemeral-1h`, `key+24h` for `prompt_cache_retention` on older OpenAI models,
 * `breakpoint-30m`). On Anthropic and Bedrock a recorded marker without a TTL (`ephemeral`, `default`: the trace leaves
 * out `5m`) and a write with no 1h part name 5m. The instructions take the longest of those. The history takes 5m when
 * any write was not 1h, because `cacheMode` names only the first marker and a longer tier can only come before a
 * shorter one: a request with 1h instructions and 5m history records `ephemeral-1h`.
 */
function namedLifetime(message: Record<string, unknown>, tier: CacheTier): number | undefined {
	const recorded = breakpointLifetime(message, tier);
	if (recorded !== undefined) return recorded;
	const usage = asRecord(message.usage);
	const mode = str(asRecord(message.requestTrace).cacheMode, "");
	const ttls = [...mode.matchAll(/(\d+)([mh])\b/g)].map(
		([, count, unit]) => Number(count) * (unit === "h" ? HOUR : MINUTE),
	);
	const fiveMinute =
		anthropicLike(message) &&
		((mode !== "" && !ttls.length) || (num(usage.cacheWrite) > 0 && !num(usage.cacheWrite1h)));
	// Some writes were not 1h (`cacheWrite1h` counts the provider's 1h part): the history marker, the last one, was 5m.
	if (tier === "history" && anthropicLike(message) && (fiveMinute || num(usage.cacheWrite) > num(usage.cacheWrite1h)))
		return ANTHROPIC_DEFAULT;
	const lifetimes = [
		num(usage.cacheWrite12h) > 0 ? 12 * HOUR : 0,
		num(usage.cacheWrite1h) > 0 ? HOUR : 0,
		fiveMinute ? ANTHROPIC_DEFAULT : 0,
		...ttls,
	];
	const longest = Math.max(...lifetimes);
	return longest > 0 ? longest : undefined;
}

const cacheKey = (message: Record<string, unknown>) => `${str(message.provider, "")}|${str(message.model, "")}`;

/**
 * The lifetime of the cache request `k` left for `tier`: the history by default (what the next request of the same
 * conversation reads), the instructions for a sibling's first request, which can share only those. A pure hit writes nothing yet refreshes the entries it read, so the tier
 * carries forward: the latest request on `k`'s branch (itself first) whose record names a lifetime gives it. The walk
 * stops at a request on another provider or model, whose cache `k` could not have read. With none, an
 * Anthropic-protocol entry lives five minutes; any other provider's lifetime is unknown (undefined), never assumed.
 *
 * Measuring from the latest hit is exact for Anthropic, where a read renews the entry's full TTL. OpenAI's 12h entries
 * (GPT-5.6 and later) are not renewed to 12h by a read: a read keeps the later of the existing expiry and 30 minutes after
 * the read (developers.openai.com/api/docs/guides/prompt-caching), so 12h from the latest hit is an approximation.
 */
export function cacheLifetimeMs(prepared: Prepared, k: number, tier: CacheTier = "history"): number | undefined {
	const steps = prepared.requests.length;
	const own = asRecord(prepared.entries[prepared.requests[k]].message);
	let at: number | undefined = k;
	for (let step = 0; at !== undefined && step < steps; step++) {
		const message = asRecord(prepared.entries[prepared.requests[at]].message);
		if (cacheKey(message) !== cacheKey(own)) break;
		const named = namedLifetime(message, tier);
		if (named !== undefined) return named;
		at = prepared.previous[at];
	}
	return anthropicLike(own) ? ANTHROPIC_DEFAULT : undefined;
}
