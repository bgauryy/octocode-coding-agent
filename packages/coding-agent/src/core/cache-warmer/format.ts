import { formatEstimate } from "@octocodeai/octocode-common/money";
import type { UsageEntry } from "../session-manager.ts";
import { CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS } from "./economics.ts";
import { formatLayerChange } from "./first-change.ts";
import type { TurnCost } from "./turn-costs.ts";
import type { CacheWarmingDecision, CacheWarmingStatus } from "./types.ts";

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	const comparison = decision.action === "warm" ? ">=" : "<";
	// The saving is an estimate; the threshold it is compared with is a fixed amount.
	return `${probabilityText}, expected savings ${formatEstimate(decision.expectedSavings, 3)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** One-line status for `/session`. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// A decision is attached once Octocode (or a feature) acted on it; "inactive"
	// without one never got that far.
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.featureOverride)) {
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	const details = status.featureOverride
		? `feature override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** Turns listed by `formatTurnCosts`, newest last. */
const SHOWN_TURNS = 5;

/**
 * The `$/turn` lines of `/session`: the average over the branch's turns, then the latest turns with their cost, request
 * count and first changed payload area. Empty without a turn that sent a request. Money is an estimate at list prices,
 * marked `≈` as everywhere, with four decimals so cheap turns still compare.
 */
export function formatTurnCosts(turns: readonly TurnCost[], dim: (text: string) => string = (text) => text): string {
	if (turns.length === 0) return "";
	const total = turns.reduce((sum, turn) => sum + turn.cost, 0);
	const floor = turns.some((turn) => turn.lowerBound) ? " (at least)" : "";
	let text = `${dim("$/turn:")} ${formatEstimate(total / turns.length, 4)} ${dim(`average over ${turns.length} turn${turns.length === 1 ? "" : "s"}${floor}`)}\n`;
	for (const turn of turns.slice(-SHOWN_TURNS)) {
		const change = turn.firstChange ? `, first change: ${formatLayerChange(turn.firstChange)}` : "";
		const requests = turn.requests === 1 ? "1 request" : `${turn.requests} requests`;
		text += `  ${dim(`Turn ${turn.turn}:`)} ${formatEstimate(turn.cost, 4)} ${dim(`(${requests}${change})`)}\n`;
	}
	return text;
}

/** One-line transcript text for persisted cache-warming usage: the refresh's estimated cost, to six decimals at most. */
export function formatCacheWarmingUsage(entry: UsageEntry): string {
	const note = entry.note ? ` (${entry.note})` : "";
	const cost = formatEstimate(entry.usage.cost.total, 6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	return `${entry.usage.cacheRead > 0 ? "Cache warmed" : "Cache refresh (no hit)"}${note}: ${cost}`;
}
