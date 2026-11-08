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

/**
 * The longest lifetime one request's record names, or undefined when it names none: a 12h write (OpenAI GPT-5.6 and
 * later), a 1h write (Anthropic, Bedrock), or a TTL in the recorded `requestTrace.cacheMode` (`ephemeral-1h`,
 * `key+24h` for `prompt_cache_retention` on older OpenAI models, `breakpoint-30m`).
 */
function namedLifetime(message: Record<string, unknown>): number | undefined {
	const usage = asRecord(message.usage);
	const mode = str(asRecord(message.requestTrace).cacheMode, "");
	const lifetimes = [
		num(usage.cacheWrite12h) > 0 ? 12 * HOUR : 0,
		num(usage.cacheWrite1h) > 0 ? HOUR : 0,
		...[...mode.matchAll(/(\d+)([mh])\b/g)].map(([, count, unit]) => Number(count) * (unit === "h" ? HOUR : MINUTE)),
	];
	const longest = Math.max(...lifetimes);
	return longest > 0 ? longest : undefined;
}

/**
 * The lifetime of the cache request `k` left. A pure hit writes nothing yet refreshes the entries it read, so the tier
 * carries forward: the latest request on `k`'s branch (itself first) whose record names a lifetime gives it. With none,
 * an Anthropic-protocol entry lives five minutes; any other provider's lifetime is unknown (undefined), never assumed.
 */
export function cacheLifetimeMs(prepared: Prepared, k: number): number | undefined {
	const steps = prepared.requests.length;
	let at: number | undefined = k;
	for (let step = 0; at !== undefined && step < steps; step++) {
		const named = namedLifetime(asRecord(prepared.entries[prepared.requests[at]].message));
		if (named !== undefined) return named;
		at = prepared.previous[at];
	}
	return anthropicLike(asRecord(prepared.entries[prepared.requests[k]].message)) ? ANTHROPIC_DEFAULT : undefined;
}
