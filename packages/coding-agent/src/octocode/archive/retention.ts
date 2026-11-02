import { HistoryRepair } from "./repair.ts";
import fs from "node:fs";
import path from "node:path";
import { type AgentDb, compactions, sessions } from "../agentdb/api.ts";
import { cleanupDays } from "../../../../common/src/env.ts";
import { DAY_MS } from "../shared/util.ts";
import { archiveFolder, isSegmentFile } from "../shared/archive.ts";
import { canonicalPath, isWithin } from "../shared/home/repo.ts";
import { writeSummaryLibrary } from "./summaries.ts";

/** Index before deleting; a damaged/unavailable transcript never authorizes loss of its only archive copy. */
export async function expireArchiveDetails(
	agent: AgentDb,
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
): Promise<void> {
	const days = cleanupDays(env);
	if (!days) return;
	const repair = new HistoryRepair(agent, env);
	for (const session of sessions.catalog(agent.db)) {
		try {
			await repair.transcript(session.file);
		} catch {
			/* This session's details remain until repair succeeds. */
		}
	}
	for (const row of compactions.expirable(agent.db, now - days * DAY_MS)) {
		const folder = canonicalPath(archiveFolder(row.sessionId, env));
		const file = row.detailFile;
		if (
			!file ||
			!isWithin(canonicalPath(file), folder) ||
			(await fs.promises.lstat(file).catch(() => undefined))?.isSymbolicLink()
		)
			continue;
		agent.transaction(() => compactions.expire(agent.db, row.sessionId, row.entryId));
		try {
			await fs.promises.rm(file, { force: true });
			await writeSummaryLibrary(agent, row.sessionId, env);
		} catch {
			/* Expiry is durable; the next sweep retries the unlink. */
		}
	}
}

/** Orphan cleanup cannot bypass the per-compaction retention rule. Claim files retain segment numbering. */
export async function mayRemoveArchive(
	agent: AgentDb,
	folder: string,
	env: NodeJS.ProcessEnv,
	now: number,
): Promise<boolean> {
	const days = cleanupDays(env);
	if (!days) return false;
	const names = await fs.promises.readdir(folder).catch((): string[] => []);
	if (!names.length) return true;
	try {
		await new HistoryRepair(agent, env).archive(folder);
	} catch {
		return false;
	}
	const id = path.basename(path.dirname(folder));
	const rows = compactions.forSession(agent.db, id);
	for (const name of names.filter(isSegmentFile)) {
		const row = rows.find((entry) => path.basename(entry.detailFile ?? "") === name);
		if (!row?.originVerified || row.committedAt === null || now - row.committedAt < days * DAY_MS) return false;
	}
	// Keep retained library and number reservations even after the transient session catalog is pruned.
	return rows.length === 0;
}
