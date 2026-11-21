import { PROFILE_FINDING_KINDS, type ProfileFinding, type ProfileFindingKind } from "@octocodeai/octocode-contracts";
import type { ProfileSelection } from "./panel-props.ts";

/** Pure ordering, grouping and summary of findings for the Insights panel. */

export const CHECK_LABELS: Record<ProfileFindingKind, string> = {
	"cache-rewrite": "Cached prefix rewritten",
	"cache-cold-start": "Cache cold at the first request",
	"cache-idle-expiry": "Cache expired while idle",
	"cache-too-short": "Prompt below the cacheable minimum",
	"tool-errors": "Tool calls that failed",
	"slow-tool": "Slow tool calls",
	"reply-wait": "Waiting for another agent's reply",
	"dead-letter": "Messages that were never delivered",
	"permission-wait": "Waiting for a permission",
	interrupt: "Interrupted runs",
	cost: "Cost outliers",
	"slow-phase": "Tool time outside execution",
	"slow-first-token": "Slow first token",
	"slow-turn-start": "Slow start from prompt to request",
	"retry-wait": "Waiting on failed requests and retries",
	"main-thread-stall": "Event loop blocked",
	silence: "Agents that went silent",
};

const SEVERITY_RANK: Record<ProfileFinding["severity"], number> = { high: 0, medium: 1, low: 2 };

/** Failed first: high, then medium, then low; the host's cost order holds within a severity. */
export function orderFindings(findings: readonly ProfileFinding[]): ProfileFinding[] {
	return findings
		.map((finding, index) => ({ finding, index }))
		.sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index)
		.map(({ finding }) => finding);
}

export interface InsightSummary {
	issues: number;
	/** Dollars the findings name as avoidable. */
	cost: number;
	waitedMs: number;
	/** Check kinds that found nothing. */
	passed: ProfileFindingKind[];
	checks: number;
}

export function summarizeFindings(findings: readonly ProfileFinding[]): InsightSummary {
	const failed = new Set(findings.map((finding) => finding.kind));
	return {
		issues: findings.length,
		cost: findings.reduce((sum, finding) => sum + (finding.cost ?? 0), 0),
		waitedMs: findings.reduce((sum, finding) => sum + (finding.waitedMs ?? 0), 0),
		passed: PROFILE_FINDING_KINDS.filter((kind) => !failed.has(kind)),
		checks: PROFILE_FINDING_KINDS.length,
	};
}

export type InsightEntry =
	| { type: "finding"; finding: ProfileFinding }
	| { type: "group"; kind: ProfileFindingKind; findings: ProfileFinding[] };

/** Kinds with more than `limit` findings fold into one group at their first finding's place; the rest stay flat. */
export function groupFindings(ordered: readonly ProfileFinding[], limit = 5): InsightEntry[] {
	const counts = new Map<ProfileFindingKind, number>();
	for (const finding of ordered) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
	const entries: InsightEntry[] = [];
	const groups = new Map<ProfileFindingKind, ProfileFinding[]>();
	for (const finding of ordered) {
		if ((counts.get(finding.kind) ?? 0) <= limit) {
			entries.push({ type: "finding", finding });
			continue;
		}
		const group = groups.get(finding.kind);
		if (group) group.push(finding);
		else {
			const findings = [finding];
			groups.set(finding.kind, findings);
			entries.push({ type: "group", kind: finding.kind, findings });
		}
	}
	return entries;
}

export type Evidence = ProfileFinding["evidence"][number];

export function evidenceSelection(item: Evidence): ProfileSelection {
	if (item.request !== undefined) return { kind: "request", agentId: item.agentId, index: item.request };
	if (item.event !== undefined) return { kind: "event", id: item.event };
	return { kind: "agent", agentId: item.agentId };
}

export function evidenceLabel(item: Evidence): string {
	return item.request !== undefined ? `${item.agentId} #${item.request}` : (item.event ?? item.agentId);
}
