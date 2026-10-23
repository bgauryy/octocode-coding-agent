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
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
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
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "usage") {
			key = `${entry.provider}/${entry.model}`;
			usage = entry.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		} else if (entry.type === "custom_message") {
			key = "Tools/summaries";
			usage = customMessageUsage(entry);
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
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
		if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0 && usage.totalTokens === 0 && usage.cost.total === 0) return;
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
