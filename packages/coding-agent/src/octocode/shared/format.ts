/** Compact numbers, durations, clock times, paths, tokens and cost for the agents panel, the footer and `coordinate list`. */
import { formatEstimate } from "@octocodeai/octocode-common/money";
import { shortPath } from "../../utils/display-path.ts";
import { formatDuration } from "../../utils/duration.ts";
import { plural } from "./text.ts";
import { DAY_MS, HOUR_MS, type TokenTotals } from "./util.ts";

/**
 * The line that goes before the end of a captured stream (`shown` of its `total` characters): how much it shows and where
 * the whole is (`file`), or that the rest could not be saved. Callers add it only when the stream did not fit.
 */
export function tailNote(label: string, shown: number, total: number, file: string | undefined): string {
	return `[${label}: last ${shown} of ${total} characters; ${file ? `whole: ${shortPath(file)}` : "the rest could not be saved"}]`;
}

/** `950`, `12.4k`, `250k`, `1.2M`, `144M`. */
export function formatTokens(count: number): string {
	const short = (value: number, unit: string) =>
		value < 100 ? `${value.toFixed(1).replace(/\.0$/, "")}${unit}` : `${Math.round(value)}${unit}`;
	if (count < 1_000) return String(count);
	return count < 999_500 ? short(count / 1_000, "k") : short(count / 1_000_000, "M");
}

/**
 * The share of `prompt` tokens read from cache, in percent rounded to `digits` decimals, or undefined without prompt
 * tokens. Rounding never claims more than happened: below a full read it stays under 100, above none it stays over 0.
 */
export function cachedPercent(read: number, prompt: number, digits = 0): number | undefined {
	if (!(prompt > 0)) return undefined;
	const step = 10 ** -digits;
	const rounded = Math.round((read / prompt) * 100 * 10 ** digits) / 10 ** digits;
	if (read >= prompt) return 100;
	if (read <= 0) return 0;
	return Math.min(100 - step, Math.max(step, rounded));
}

/** Prompt tokens that were not read from cache: uncached input and cache writes. */
export const newPromptTokens = (usage: Pick<TokenTotals, "input" | "cacheRead">): number =>
	Math.max(0, usage.input - usage.cacheRead);

/**
 * The one token format: `↑72k +1.1M cached ↓35k`. ↑ is the prompt tokens not read from cache (uncached input and cache
 * writes); `cached` is the cache reads, shown when there are any. Every request re-reads the whole conversation, so cache
 * reads grow with each turn and dwarf the rest while costing a fraction of it. Empty when nothing was spent.
 */
export function formatTokenUsage(usage: Pick<TokenTotals, "input" | "cacheRead" | "output">): string {
	if (!usage.input && !usage.output) return "";
	const cached = usage.cacheRead > 0 ? ` +${formatTokens(usage.cacheRead)} cached` : "";
	return `↑${formatTokens(newPromptTokens(usage))}${cached} ↓${formatTokens(usage.output)}`;
}

/**
 * The one money format. Octocode prices replies at the model's list rates (`models.json`), not at what a gateway bills, so it
 * reads as an estimate: `≈$2.28`. Usage from a model without pricing is never shown as free: `≈$2.28 + n/a`, or
 * `cost n/a` when no part was priced. Empty when nothing was spent.
 */
export function formatCost(usage: Pick<TokenTotals, "cost" | "unpriced">): string {
	const money = usage.cost > 0 ? (usage.cost < 0.01 ? "≈$<0.01" : formatEstimate(usage.cost)) : "";
	if (!usage.unpriced) return money;
	return money ? `${money} + n/a` : "cost n/a";
}

/** A run's cost as `formatCost` writes it, or `(sub)` when a plan paid for its tokens: a plan shows no fake $0. */
export function formatSpend(usage: Pick<TokenTotals, "cost" | "unpriced">, billing: string | undefined): string {
	return billing === "plan" ? "(sub)" : formatCost(usage);
}

export { formatDuration };

/**
 * A coarse span for times that are read, not measured: `45s`, `12m`, `5h20m`, `3d4h`. Under a day it is `formatDuration`
 * without the seconds of a span over a minute; from a day on it counts days.
 */
export function formatSpan(ms: number): string {
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	if (safe < DAY_MS) return formatDuration(safe).replace(/(\d+m)\d+s$/, "$1");
	const days = Math.floor(safe / DAY_MS);
	const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
	return `${days}d${hours ? `${hours}h` : ""}`;
}

/** The one relative-time format: `45s ago`, `12m ago`, `5h20m ago`, `3d4h ago`. */
export const formatAgo = (ms: number): string => `${formatSpan(ms)} ago`;

export const toolCallCount = (count: number) => plural(count, "tool call");

export const formatClock = (at: number) => new Date(at).toTimeString().slice(0, 8);

/** `7 tool calls · ↑12k +4k cached ↓3k · ≈$0.02`: an agent's work in `coordinate list` and /agents. */
export function memberStats(member: { toolCalls: number } & TokenTotals): string {
	return [toolCallCount(member.toolCalls), formatTokenUsage(member), formatCost(member)].filter(Boolean).join(" · ");
}
