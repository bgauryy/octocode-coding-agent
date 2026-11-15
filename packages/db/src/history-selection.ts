import type { ArchiveRecord, ArchiveRow } from "./history-record.ts";

/** Retain only the requested newest rows while scanning; equal ids keep their original encounter order. */
export function auditSelection(
	source: string,
	floor: number,
	repo: string,
	ref: string | undefined,
	before: number | undefined,
	limit: number,
) {
	const rows: ArchiveRow[] = [];
	const count = Math.max(0, Math.floor(limit));
	const accept = (record: ArchiveRecord) => {
		if (
			!(count > 0) ||
			record.db !== source ||
			record.at < floor ||
			record.row.workspace_id !== repo ||
			(ref !== undefined && record.row.backlog_id !== ref) ||
			(before !== undefined && Number(record.row.id) >= before)
		)
			return;
		const id = Number(record.row.id);
		if (rows.length === count && id <= Number(rows[rows.length - 1].id)) return;
		let lo = 0,
			hi = rows.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (Number(rows[mid].id) >= id) lo = mid + 1;
			else hi = mid;
		}
		rows.splice(lo, 0, record.row);
		if (rows.length > count) rows.pop();
	};
	return { accept, rows };
}
