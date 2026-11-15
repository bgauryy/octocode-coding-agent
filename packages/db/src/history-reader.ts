import type { AgentDb } from "./db.ts";
import { archiveSource, windowsMs, type ArchiveAuditQuery, type ArchiveRow } from "./history-archive.ts";
import { monthFiles, pruneMonthCache, visitMonth } from "./history-month.ts";
import { auditSelection } from "./history-selection.ts";

/** Stream archive months in the worker; malformed months contribute no partial result. Cancellation still propagates. */
export async function readArchivedAudits(
	agent: Pick<AgentDb, "file" | "archiveDir">,
	query: ArchiveAuditQuery,
	assertActive: () => void,
): Promise<ArchiveRow[]> {
	const { now, repo, ref, before, windows } = query;
	const limit = Math.min(500, Math.max(1, Math.floor(query.limit)));
	const floor = now - windowsMs(windows).keepMs;
	const files = monthFiles(agent.archiveDir, "audits").filter((month) => month.end > floor);
	pruneMonthCache(
		agent.archiveDir,
		files.map((month) => month.file),
	);
	const source = archiveSource(agent);
	const all = auditSelection(source, floor, repo, ref, before, limit);
	for (const { file } of files) {
		assertActive();
		const month = auditSelection(source, floor, repo, ref, before, limit);
		try {
			await visitMonth(file, month.accept, assertActive);
		} catch {
			assertActive();
			continue;
		}
		for (const row of month.rows) all.accept({ db: source, at: floor, id: String(row.id), row });
	}
	assertActive();
	return all.rows;
}
