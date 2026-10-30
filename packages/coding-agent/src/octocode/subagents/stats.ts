import { childCacheLabel } from "./cache-monitor.ts";
import { REPORT_STATUSES } from "../instructions/report.ts";
import { formatCost, formatTokens } from "../shared/format.ts";
import { AGENT_RESULT_TYPE } from "../shared/messages.ts";
import { plural } from "../shared/render/text.ts";
import { entryMessage, finiteOrZero } from "../shared/util.ts";
import { isRecord } from "../../utils/guards.ts";

type StatsOutcome = (typeof REPORT_STATUSES)[number] | "unknown";

/** What one profile's runs came to in a session. */
interface ProfileStats {
	profile: string;
	runs: number;
	foreground: number;
	background: number;
	outcomes: Record<StatsOutcome, number>;
	/** Runs that ended on their own (not failed, not stopped) and named an outcome as their first word, of those that ended on their own. */
	ended: number;
	named: number;
	/** Runs whose outcome came from a labelled last line (`outcome: done`) instead of the first word. */
	trailing: number;
	tokens: number;
	cost: number;
	/** Some run's usage came from a model without pricing (it is missing from `cost`). */
	unpriced: boolean;
	asks: number;
	/** Runs that failed before their first model turn (`details.startup.failed`). */
	startupFailures: number;
	compactions: number;
	/** First-request context, including cached input. Keep the legacy field name for stats consumers. */
	cold: { runs: number; tokens: number };
	/** Model requests of each run that recorded them (`details.requests`), in the order the runs came. */
	requests: number[];
	cache: { requests: number; promptTokens: number; cacheRead: number; cacheWrite: number };
}

const emptyStats = (profile: string): ProfileStats => ({
	profile,
	runs: 0,
	foreground: 0,
	background: 0,
	outcomes: { done: 0, partial: 0, blocked: 0, failed: 0, unknown: 0 },
	ended: 0,
	named: 0,
	trailing: 0,
	tokens: 0,
	cost: 0,
	unpriced: false,
	asks: 0,
	startupFailures: 0,
	compactions: 0,
	cold: { runs: 0, tokens: 0 },
	requests: [],
	cache: { requests: 0, promptTokens: 0, cacheRead: 0, cacheWrite: 0 },
});

interface Run {
	foreground: boolean;
	details: Record<string, unknown>;
	usage: Record<string, unknown> | undefined;
}

/**
 * The subagent run a session entry records, or undefined: a background report (`octocode-agent-result` custom message,
 * `details.usage`) or a finished foreground `agent` tool result (`usage` on the result, `RunDetails` as details). A
 * foreground result still `waiting`, `running` or `background` (the launch of a background run) is not a run.
 */
function runOf(entry: unknown): Run | undefined {
	const message = entryMessage(entry);
	if (!isRecord(message) || !isRecord(message.details)) return undefined;
	const details = message.details;
	if (message.role === "custom") {
		if (message.customType !== AGENT_RESULT_TYPE || typeof details.id !== "string") return undefined;
		return { foreground: false, details, usage: isRecord(details.usage) ? details.usage : undefined };
	}
	if (message.role !== "toolResult" || message.toolName !== "agent") return undefined;
	if (typeof details.id !== "string" || typeof details.profile !== "string") return undefined;
	if (details.status !== "done" && details.status !== "failed") return undefined;
	const usage = isRecord(message.usage) ? message.usage : undefined;
	return { foreground: true, details, usage };
}

function tokensOf(run: Run): number {
	const { usage, details } = run;
	if (usage)
		return (
			finiteOrZero(usage.input) +
			finiteOrZero(usage.output) +
			finiteOrZero(usage.cacheRead) +
			finiteOrZero(usage.cacheWrite)
		);
	// `RunDetails.input` already holds the cache reads and writes.
	return finiteOrZero(details.input) + finiteOrZero(details.output);
}

const costOf = (run: Run): number =>
	isRecord(run.usage?.cost) ? finiteOrZero(run.usage.cost.total) : run.usage ? 0 : finiteOrZero(run.details.cost);

/** A run's outcome; `named`: stated as the first word (a run recorded before sources were kept counts as first). */
function outcomeOf(details: Record<string, unknown>): { outcome: StatsOutcome; named: boolean; trailing: boolean } {
	const word = REPORT_STATUSES.find((status) => status === details.outcome);
	const trailing = Boolean(word) && details.outcomeSource === "last";
	if (word) return { outcome: word, named: !trailing, trailing };
	return { outcome: details.status === "failed" ? "failed" : "unknown", named: false, trailing: false };
}

function compactionsOf(details: Record<string, unknown>): number {
	return isRecord(details.compactions) ? finiteOrZero(details.compactions.done) : 0;
}

/** The `fraction` quantile (nearest rank) of `values`, which are not empty. */
function quantile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

/** Per-profile statistics of the subagent runs in session entries (`general` for a run with no role), most runs first. */
export function agentStats(entries: readonly unknown[]): ProfileStats[] {
	const byProfile = new Map<string, ProfileStats>();
	const seen = new Set<string>();
	for (const entry of entries) {
		const run = runOf(entry);
		if (!run) continue;
		// A report delivered twice (a retry) counts once.
		const reportId = typeof run.details.reportId === "string" ? run.details.reportId : undefined;
		if (reportId) {
			if (seen.has(reportId)) continue;
			seen.add(reportId);
		}
		const profile =
			typeof run.details.profile === "string" && run.details.profile.trim() ? run.details.profile.trim() : "general";
		let stats = byProfile.get(profile);
		if (!stats) byProfile.set(profile, (stats = emptyStats(profile)));
		const { details } = run;
		stats.runs++;
		if (run.foreground) stats.foreground++;
		else stats.background++;
		const { outcome, named, trailing } = outcomeOf(details);
		stats.outcomes[outcome]++;
		if (details.status === "done") {
			stats.ended++;
			if (named) stats.named++;
			if (trailing) stats.trailing++;
		}
		stats.tokens += tokensOf(run);
		stats.cost += costOf(run);
		if (details.unpriced === true) stats.unpriced = true;
		if (Array.isArray(details.asks)) stats.asks += details.asks.length;
		stats.compactions += compactionsOf(details);
		if (isRecord(details.cache)) {
			for (const key of ["requests", "promptTokens", "cacheRead", "cacheWrite"] as const)
				stats.cache[key] += finiteOrZero(details.cache[key]);
		}
		if (isRecord(details.startup) && details.startup.failed === true) stats.startupFailures++;
		if (typeof details.firstTurnTokens === "number" && details.firstTurnTokens > 0) {
			stats.cold.runs++;
			stats.cold.tokens += details.firstTurnTokens;
		}
		if (typeof details.requests === "number" && details.requests >= 0) stats.requests.push(details.requests);
	}
	return [...byProfile.values()].sort((a, b) => b.runs - a.runs || a.profile.localeCompare(b.profile));
}

function describe(stats: ProfileStats): string[] {
	const { outcomes } = stats;
	const compliance = stats.ended > 0 ? `${Math.round((stats.named / stats.ended) * 100)}%` : "n/a";
	const split = [
		stats.foreground ? `${stats.foreground} foreground` : "",
		stats.background ? `${stats.background} background` : "",
	]
		.filter(Boolean)
		.join(", ");
	const initialContext =
		stats.cold.runs > 0
			? ` · initial context ${formatTokens(Math.round(stats.cold.tokens / stats.cold.runs))} avg`
			: "";
	const requests =
		stats.requests.length > 0
			? ` · requests p50 ${quantile(stats.requests, 0.5)} · p95 ${quantile(stats.requests, 0.95)} · max ${Math.max(...stats.requests)}`
			: "";
	const cost = formatCost(stats) || (stats.runs > 0 && !stats.unpriced ? "≈$0" : "cost n/a");
	return [
		`${stats.profile} — ${plural(stats.runs, "run")} (${split})`,
		`  outcomes: done ${outcomes.done} · partial ${outcomes.partial} · blocked ${outcomes.blocked} · failed ${outcomes.failed} · unknown ${outcomes.unknown} · outcome word ${compliance}${stats.trailing ? ` · trailing outcome ${stats.trailing}` : ""}`,
		`  tokens: ${formatTokens(stats.tokens)} total · ${formatTokens(Math.round(stats.tokens / stats.runs))} avg${initialContext}`,
		...(stats.cache.requests > 0
			? [`  conversation cache: ${childCacheLabel(stats.cache)} · ${stats.cache.requests} requests`]
			: []),
		`  cost ${cost} · ${plural(stats.asks, "ask")} · ${plural(stats.startupFailures, "startup failure")} · ${plural(stats.compactions, "compaction")}${requests}`,
	];
}

/** The `/agents stats` text. */
export function renderStats(stats: readonly ProfileStats[]): string {
	if (stats.length === 0) return "No subagent runs in this session yet.";
	const runs = stats.reduce((sum, item) => sum + item.runs, 0);
	return [
		`Subagent stats for this session: ${plural(runs, "run")}, ${plural(stats.length, "profile")}`,
		...stats.flatMap((item) => ["", ...describe(item)]),
	].join("\n");
}
