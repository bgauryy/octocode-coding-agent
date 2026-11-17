import type { AssistantMessage, Usage } from "@octocodeai/octocode-ai/compat";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** Sum of two usages, keeping the optional token splits when either side reports them. */
export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.cacheWrite12h !== undefined || second.cacheWrite12h !== undefined
			? { cacheWrite12h: (first.cacheWrite12h ?? 0) + (second.cacheWrite12h ?? 0) }
			: {}),
		...(first.cacheWrite30m !== undefined || second.cacheWrite30m !== undefined
			? { cacheWrite30m: (first.cacheWrite30m ?? 0) + (second.cacheWrite30m ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		...(first.lowerBound || second.lowerBound ? { lowerBound: true } : {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * The spend a `custom_message` entry carries in `details.usage`, normalized, or undefined. A background subagent's report
 * carries its run's total there; foreground runs carry theirs on the tool result.
 */
export function customMessageUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "custom_message") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const usage = (details as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const raw = usage as Record<string, unknown>;
	const cost = raw.cost && typeof raw.cost === "object" ? (raw.cost as Record<string, unknown>) : {};
	const normalized: Usage = {
		input: finite(raw.input),
		output: finite(raw.output),
		cacheRead: finite(raw.cacheRead),
		cacheWrite: finite(raw.cacheWrite),
		...(raw.lowerBound === true ? { lowerBound: true } : {}),
		totalTokens: finite(raw.totalTokens),
		cost: {
			input: finite(cost.input),
			output: finite(cost.output),
			cacheRead: finite(cost.cacheRead),
			cacheWrite: finite(cost.cacheWrite),
			total: finite(cost.total),
		},
	};
	const tokens = normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite;
	return tokens > 0 || normalized.cost.total > 0 ? normalized : undefined;
}

interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
	/** A plan paid for these tokens (an external runner on its own subscription): they have no cost to show. */
	plan?: true;
}

const TOOLS_AND_SUMMARIES = "Tools/summaries";

/**
 * Where a subagent's run carries who paid for it: the details of its tool result (foreground) or report (background).
 * A plan-billed runner run is listed apart, under its route (`claude-code/sonnet`), so its tokens are not priced.
 */
function planBilled(details: unknown): { key: string; plan: true } | undefined {
	if (!details || typeof details !== "object") return undefined;
	const { billing, model } = details as { billing?: unknown; model?: unknown };
	if (billing !== "plan") return undefined;
	return { key: typeof model === "string" && model ? model : TOOLS_AND_SUMMARIES, plan: true };
}

/**
 * The spend a session entry carries and its cost-breakdown bucket: a reply's or a `usage` entry's under `provider/model`;
 * a tool result's (a foreground subagent), a compaction or branch summary's and a background subagent report's under
 * "Tools/summaries"; a plan-billed runner run's under its route, marked `plan`. The /session totals and its breakdown both
 * read entries through this, so they count the same ones.
 */
export function entryUsage(entry: SessionEntry): { key: string; usage: Usage; plan?: true } | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant")
			return { key: `${message.provider}/${message.responseModel ?? message.model}`, usage: message.usage };
		if (message.role === "toolResult" && message.usage)
			return { key: TOOLS_AND_SUMMARIES, ...planBilled(message.details), usage: message.usage };
		return undefined;
	}
	if (entry.type === "usage") return { key: `${entry.provider}/${entry.model}`, usage: entry.usage };
	if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)
		return { key: TOOLS_AND_SUMMARIES, usage: entry.usage };
	const usage = customMessageUsage(entry);
	if (!usage) return undefined;
	return { key: TOOLS_AND_SUMMARIES, ...(entry.type === "custom_message" ? planBilled(entry.details) : {}), usage };
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, { key: string; plan?: true; totals: UsageTotals }>();

	for (const entry of entries) {
		const spend = entryUsage(entry);
		if (!spend) continue;
		const { key, usage, plan } = spend;
		const bucket = `${plan ? "plan" : "priced"}:${key}`;
		let group = totalsByKey.get(bucket);
		if (!group) {
			group = { key, ...(plan ? { plan } : {}), totals: createUsageTotals() };
			totalsByKey.set(bucket, group);
		}
		addUsageToTotals(group.totals, usage);
	}

	return Array.from(totalsByKey.values(), ({ key, plan, totals }) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		...(plan ? { plan } : {}),
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}

export class UsagePersistenceError extends Error {}

export function createSessionUsageRecorder(
	manager: SessionManager,
	kind: string,
	onRecorded?: (entry: UsageEntry) => void,
): (message: AssistantMessage) => void {
	const write = manager.captureUsageWriter();
	const sessionId = manager.getSessionId();
	const sessionFile = manager.getSessionFile();
	const recorded = new WeakSet<AssistantMessage>();
	return (message) => {
		if (recorded.has(message)) return;
		const usage = message.usage;
		if (
			usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0 &&
			usage.totalTokens === 0 &&
			usage.cost.total === 0
		)
			return;
		let entry: UsageEntry;
		try {
			entry = write(kind, message.provider, message.responseModel ?? message.model, usage);
		} catch (error) {
			throw new UsagePersistenceError(`Could not preserve reported usage: ${String(error)}`);
		}
		recorded.add(message);
		if (manager.getSessionId() === sessionId && manager.getSessionFile() === sessionFile) onRecorded?.(entry);
	};
}
