import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { ModelThinkingLevel } from "@octocodeai/octocode-ai";
import { EFFORT_LADDER } from "./signals.ts";
import { type Cooldown, type FailureKind, MAX_COOLDOWNS, type SmartRouterState } from "./types.ts";

function emptyState(): SmartRouterState {
	return { v: 1, seq: 0, failures: 0, cooldowns: [] };
}

const FAILURE_KINDS: readonly string[] = ["context", "transient", "access", "quality", "aborted"];

function isEffort(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (EFFORT_LADDER as readonly string[]).includes(value);
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * State from a session branch. Anything malformed (an older or edited session) is dropped instead of
 * trusted, so routing restarts clean rather than failing.
 */
export function readState(raw: unknown): SmartRouterState {
	if (!isRecord(raw) || raw.v !== 1) return emptyState();
	const cooldowns: Cooldown[] = [];
	if (Array.isArray(raw.cooldowns)) {
		for (const item of raw.cooldowns.slice(0, MAX_COOLDOWNS)) {
			if (
				isRecord(item) &&
				typeof item.key === "string" &&
				item.key.length <= 200 &&
				typeof item.kind === "string" &&
				FAILURE_KINDS.includes(item.kind)
			) {
				cooldowns.push({ key: item.key, until: count(item.until), kind: item.kind as FailureKind });
			}
		}
	}
	const sticky = isRecord(raw.sticky) ? raw.sticky : undefined;
	return {
		v: 1,
		seq: count(raw.seq),
		failures: count(raw.failures),
		cooldowns,
		usedPlan: raw.usedPlan === true ? true : undefined,
		sticky:
			sticky && typeof sticky.key === "string" && sticky.key.length <= 200 && isEffort(sticky.effort)
				? { key: sticky.key, effort: sticky.effort }
				: undefined,
		// `last` is diagnostics only and is replaced on every routed request.
	};
}

function newestFirst(cooldowns: readonly Cooldown[]): Cooldown[] {
	return [...cooldowns].sort((a, b) => b.until - a.until || (a.key < b.key ? -1 : 1)).slice(0, MAX_COOLDOWNS);
}

/** Cooldowns still in force at `seq`, newest `until` first, capped. */
export function activeCooldowns(cooldowns: readonly Cooldown[], seq: number): Cooldown[] {
	return newestFirst(cooldowns.filter((cooldown) => cooldown.until >= seq));
}

/** Put `key` out of rotation through request `until`, replacing an older entry for it. The list stays capped. */
export function withCooldown(cooldowns: readonly Cooldown[], entry: Cooldown): Cooldown[] {
	return newestFirst([...cooldowns.filter((cooldown) => cooldown.key !== entry.key), entry]);
}
