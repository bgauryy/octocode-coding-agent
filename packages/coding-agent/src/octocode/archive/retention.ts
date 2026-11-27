import { readWorkspaceIdentity } from "../../storage/workspace.ts";
import { HistoryRepair } from "./repair.ts";
import { repairCatalog } from "./repair-stamps.ts";
import fs from "node:fs";
import path from "node:path";
import { type AgentDb, compactions, workspaces } from "../../../../db/src/api.ts";
import { resolveRetention } from "../../storage/retention.ts";
import { DAY_MS } from "../shared/util.ts";
import { archiveFolder, isSegmentFile } from "../history/archive.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { writeSummaryLibrary } from "./summaries.ts";

/** Index before deleting; a damaged/unavailable transcript never authorizes loss of its only archive copy. */
export async function expireArchiveDetails(
	agent: AgentDb,
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
): Promise<void> {
	const { days } = resolveRetention(env);
	if (!days) return;
	await repairCatalog(agent, new HistoryRepair(agent, env));
	for (const row of compactions.expirable(agent.mirror.db, now - days * DAY_MS)) {
		const workspace = workspaces.byId(agent.db, row.workspace);
		if (!workspace) continue;
		const marker = readWorkspaceIdentity(workspace.root);
		if (marker?.id !== workspace.id || marker.binding !== workspace.binding) continue;
		const folder = archiveFolder(row.sessionId, env, workspace.root);
		const file = row.detailFile;
		if (
			!file ||
			canonicalPath(file) !== file ||
			!isWithin(file, folder) ||
			(await fs.promises.lstat(file).catch(() => undefined))?.isSymbolicLink()
		)
			continue;
		agent.mirror.transaction(() => compactions.expire(agent.mirror.db, row.sessionId, row.entryId));
		try {
			await fs.promises.rm(file, { force: true });
			await writeSummaryLibrary(agent, row.sessionId, env, workspace.root);
		} catch {
			/* Expiry is durable; the next sweep retries the unlink. */
		}
	}
}

/**
 * Orphan cleanup cannot bypass the per-compaction retention rule. Claim files retain segment numbering. With
 * `dropsRows` the caller forgets the session's database rows too (an expired transcript), so the retained summary
 * library and number reservations need not outlive the folder; the age rule still holds for every segment.
 */
export async function mayRemoveArchive(
	agent: AgentDb,
	folder: string,
	env: NodeJS.ProcessEnv,
	now: number,
	options: { dropsRows?: boolean } = {},
): Promise<boolean> {
	const { days } = resolveRetention(env);
	if (!days) return false;
	const names = await fs.promises.readdir(folder).catch((): string[] => []);
	if (!names.length) return true;
	try {
		await new HistoryRepair(agent, env).archive(folder);
	} catch {
		return false;
	}
	const id = path.basename(path.dirname(folder));
	const rows = compactions.forSession(agent.mirror.db, id);
	for (const name of names.filter(isSegmentFile)) {
		const row = rows.find((entry) => path.basename(entry.detailFile ?? "") === name);
		if (!row?.originVerified || row.committedAt === null || now - row.committedAt < days * DAY_MS) return false;
	}
	// Keep retained library and number reservations even after the transient session catalog is pruned.
	return options.dropsRows === true || rows.length === 0;
}
