import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { maintenance, purge, type MaintenanceResult, type PurgeCounts } from "../../../../db/src/api.ts";
import { getSessionsDir } from "../../config.ts";
import { formatBytes } from "@octocodeai/octocode-common/bytes";
import { type PurgeKind, type PurgePlan, type PurgeScope, planPurge, type PlanOptions } from "./purge-plan.ts";
import type { SessionIndex } from "./store.ts";
import { strictlyInside } from "./sweep-fs.ts";

export { planPurge };
export type { PurgePlan, PurgeScope };

export interface PurgeResult {
	scope: PurgeScope;
	/** Entries removed per kind, and their bytes as planned. */
	removed: Partial<Record<PurgeKind, number>>;
	bytes: number;
	failed: { path: string; error: string }[];
	/** Database rows removed per table. */
	rows: PurgeCounts;
	vacuum?: MaintenanceResult;
}

const KIND_LABEL: Record<PurgeKind, string> = {
	transcript: "session transcripts",
	"legacy-transcript": "legacy transcripts",
	"session-data": "session data folders",
	temp: "temp entries",
	scratch: "<root>/.octocode/tmp entries",
	"old-database": "old octocode.db files",
};

/** What the plan would remove, one line per kind with counts and sizes, then the database and what stays. */
export function previewLines(plan: PurgePlan, dbBytes: number): string[] {
	const lines: string[] = [];
	for (const kind of Object.keys(KIND_LABEL) as PurgeKind[]) {
		const items = plan.items.filter((item) => item.kind === kind);
		if (items.length === 0) continue;
		const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
		lines.push(`  ${items.length} ${KIND_LABEL[kind]} (${formatBytes(bytes)})`);
	}
	const where =
		plan.scope === "all"
			? "every registered workspace"
			: plan.workspaces.map((w) => w.root).join(", ") || "this workspace";
	lines.push(
		`  database rows of ${where}${plan.scope === "all" ? " (schema, trusted folders and settings kept)" : ""} (database ${formatBytes(dbBytes)}; compacted afterwards)`,
	);
	if (plan.skipped.length > 0)
		lines.push(`  skipped: ${plan.skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}`);
	lines.push(
		"  kept: settings, auth.json, mcp-auth.json, child-credentials, MCP configuration, workspace ids, trusted folders, other .octocode folders and your own files",
	);
	if (plan.current) lines.push(`  the current session (${plan.current}) is kept, so it can continue`);
	return lines;
}

/** Why the purge is refused while other processes hold sessions in scope; undefined when none does. */
export function blockerText(plan: PurgePlan): string | undefined {
	if (plan.blockers.length === 0) return undefined;
	return `Another Octocode process holds data in scope; close it first: ${plan.blockers.map((b) => `${b.what} (pid ${b.pid})`).join(", ")}.`;
}

/** The size of the agent database's files (coordination and transcript mirror), for the preview. */
export const databaseBytes = (index: SessionIndex): number =>
	maintenance.checkpoint(index.agent.db).bytesAfter + maintenance.checkpoint(index.agent.mirror.db).bytesAfter;

/** Both files' `VACUUM`, as one result: their sizes summed, busy when either was. */
function vacuumBoth(index: SessionIndex): MaintenanceResult {
	const parts = [maintenance.vacuum(index.agent.mirror.db), maintenance.vacuum(index.agent.db)];
	return {
		busy: parts.some((part) => part.busy),
		bytesBefore: parts.reduce((sum, part) => sum + part.bytesBefore, 0),
		bytesAfter: parts.reduce((sum, part) => sum + part.bytesAfter, 0),
	};
}

/**
 * Removes what `plan` lists, then the database rows (`purge.workspace` per workspace, or `purge.all`), vacuums, and for
 * `all` drops the old database files that were listed. Each path is checked again to lie strictly inside its root; a
 * path that cannot be removed lands in `failed` and the rest go on. The current session keeps working: the database purge
 * spares all of its rows. Never throws.
 */
async function applyPurge(
	index: SessionIndex,
	plan: PurgePlan,
	options: PlanOptions & { legacyRoot?: string },
): Promise<PurgeResult> {
	const result: PurgeResult = { scope: plan.scope, removed: {}, bytes: 0, failed: [], rows: {} };
	const emptied = new Set<string>();
	for (const item of plan.items) {
		if (!strictlyInside(item.root, item.path)) {
			result.failed.push({ path: item.path, error: "outside its root" });
			continue;
		}
		try {
			await fs.promises.rm(item.path, { recursive: true, force: true });
			result.removed[item.kind] = (result.removed[item.kind] ?? 0) + 1;
			result.bytes += item.bytes;
			if (item.kind === "legacy-transcript") emptied.add(path.dirname(item.path));
		} catch (error) {
			result.failed.push({ path: item.path, error: errorMessage(error) });
		}
	}
	// An emptied legacy per-folder directory goes too (never the legacy root itself).
	const legacy = options.legacyRoot ?? getSessionsDir();
	for (const dir of emptied) if (strictlyInside(legacy, dir)) await fs.promises.rmdir(dir).catch(() => undefined);
	try {
		const { db } = index.agent;
		const mirror = index.agent.mirror.db;
		// The current session keeps every row (mirror, compaction summaries, tasks) and the workspace row it references.
		const keepSessions = plan.current ? [plan.current] : [];
		if (plan.scope === "all") result.rows = purge.all(db, mirror, { keepSessions });
		else
			for (const workspace of plan.workspaces)
				for (const [table, n] of Object.entries(purge.workspace(db, mirror, workspace.id, { keepSessions })))
					result.rows[table] = (result.rows[table] ?? 0) + n;
		result.vacuum = vacuumBoth(index);
	} catch (error) {
		result.failed.push({ path: "agent database", error: errorMessage(error) });
	}
	return result;
}

/** The outcome as text: counts, failures, and the database size before and after. */
export function resultLines(result: PurgeResult): string[] {
	const removed = (Object.keys(KIND_LABEL) as PurgeKind[])
		.filter((kind) => result.removed[kind])
		.map((kind) => `${result.removed[kind]} ${KIND_LABEL[kind]}`);
	const rows = Object.values(result.rows).reduce((sum, n) => sum + n, 0);
	const lines = [
		`Purged ${result.scope}: ${removed.join(", ") || "no files"} (${formatBytes(result.bytes)}), ${rows} database rows.`,
	];
	if (result.vacuum)
		lines.push(
			result.vacuum.busy
				? `Database ${formatBytes(result.vacuum.bytesBefore)}; compaction was blocked by another connection, so it was not shrunk.`
				: `Database ${formatBytes(result.vacuum.bytesBefore)} → ${formatBytes(result.vacuum.bytesAfter)}.`,
		);
	for (const { path: file, error } of result.failed) lines.push(`Could not remove ${file}: ${error}`);
	return lines;
}

/**
 * The purge as one operation for the command and RPC: plans afresh (the preview may be stale), refuses while another
 * process holds data in scope, then applies. `refused` carries the reason when nothing was removed.
 */
export async function executePurge(
	index: SessionIndex,
	scope: PurgeScope,
	options: PlanOptions,
): Promise<{ refused: string } | { result: PurgeResult }> {
	const plan = await planPurge(index, scope, options);
	const blocked = blockerText(plan);
	if (blocked) return { refused: blocked };
	return { result: await applyPurge(index, plan, options) };
}
