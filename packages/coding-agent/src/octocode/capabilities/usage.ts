/**
 * Tool usage for MCP contract tiers (`packages/mcp/src/contract-tiers.ts`). Each session adds itself once to the day's
 * count with its first tool call, and each tool once with its first call; a day's snapshot of the resident set is built
 * once from the 28 days before it and frozen, so every session of one workspace, agent scope and day describes the
 * same tools in the cached `mcps` block. Storage is `capabilityUsage` in the agent database.
 */

import type { AgentDb } from "../../../../db/src/api.ts";
import { capabilityUsage } from "../../../../db/src/api.ts";
import { type ContractUsage, residentByUsage } from "../../../../mcp/src/contract-tiers.ts";

/** Days of usage one snapshot weighs: four weeks smooth out a quiet day or a one-off task. */
export const USAGE_WINDOW_DAYS = 28;
/** Usage and snapshots older than this are dropped when a snapshot is built. */
export const USAGE_RETENTION_DAYS = 60;

/** The scope usage is kept under: a subagent's profile (role), else `main`. */
export const usageScope = (role: string | undefined, isSubagent: boolean): string =>
	isSubagent ? role || "general" : "main";

/** The local calendar day of `at` (`YYYY-MM-DD`). */
export function localDay(at: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The local day `days` before `day`. */
export function dayBefore(day: string, days: number): string {
	const [year, month, date] = day.split("-").map(Number);
	return localDay(new Date(year, month - 1, date - days));
}

interface Snapshot {
	sessions: number;
	resident: string[];
}

const parseSnapshot = (value: string | undefined): Snapshot | undefined => {
	if (value === undefined) return undefined;
	try {
		const parsed = JSON.parse(value) as Partial<Snapshot>;
		return typeof parsed.sessions === "number" && Array.isArray(parsed.resident)
			? { sessions: parsed.sessions, resident: parsed.resident.filter((name) => typeof name === "string") }
			: undefined;
	} catch {
		return undefined;
	}
};

/**
 * The day's snapshot, built and stored on first need: sessions in the window and the tools resident by their session
 * share (`residentByUsage`, with the previous snapshot's set for hysteresis). One transaction, so two sessions that start
 * together store and read one snapshot.
 */
export function daySnapshot(agent: AgentDb, workspace: string, scope: string, day: string): ContractUsage {
	const snapshot = agent.transaction(() => {
		const stored = parseSnapshot(capabilityUsage.readSnapshot(agent.db, workspace, scope, day));
		if (stored) return stored;
		capabilityUsage.pruneBefore(agent.db, dayBefore(day, USAGE_RETENTION_DAYS));
		const days = capabilityUsage.usageBetween(
			agent.db,
			workspace,
			scope,
			dayBefore(day, USAGE_WINDOW_DAYS),
			dayBefore(day, 1),
		);
		let sessions = 0;
		const counts = new Map<string, number>();
		for (const usage of days.values()) {
			sessions += usage.sessions;
			for (const [tool, count] of Object.entries(usage.tools)) counts.set(tool, (counts.get(tool) ?? 0) + count);
		}
		const shares = new Map([...counts].map(([tool, count]) => [tool, sessions ? count / sessions : 0]));
		const previous = parseSnapshot(capabilityUsage.previousSnapshot(agent.db, workspace, scope, day)?.value);
		const built: Snapshot = { sessions, resident: residentByUsage(shares, new Set(previous?.resident)) };
		capabilityUsage.writeSnapshot(agent.db, workspace, scope, day, JSON.stringify(built));
		return built;
	});
	return { sessions: snapshot.sessions, resident: new Set(snapshot.resident) };
}

/** Counts one session's first calls (`capabilityUsage.addUsage`): the first call of the session, and of each tool. */
export class UsageRecorder {
	readonly #seen = new Set<string>();
	#counted = false;

	/** Forget this session's calls: a new or resumed session counts again. */
	reset(): void {
		this.#seen.clear();
		this.#counted = false;
	}

	record(agent: AgentDb, workspace: string, scope: string, day: string, tool: string): void {
		if (this.#seen.has(tool)) return;
		const session = !this.#counted;
		agent.transaction(() => capabilityUsage.addUsage(agent.db, workspace, scope, day, { session, tools: [tool] }));
		this.#seen.add(tool);
		this.#counted = true;
	}
}
