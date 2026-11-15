/** A history row's columns (text, integers or NULL; these tables hold no blobs). */
export type ArchiveRow = Record<string, string | number | null>;

/**
 * One archived row: `db` names the database it came from (several databases may share one Octocode home, and their ids
 * collide), `id` is its key within that table, `at` when it was written, `row` every column as stored.
 */
export interface ArchiveRecord {
	db: string;
	id: string;
	at: number;
	row: ArchiveRow;
}

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Refuse malformed records before a rewrite can discard them or delete their source rows. */
export function parseArchiveRecord(line: string, audit = false): ArchiveRecord {
	const value: unknown = JSON.parse(line);
	if (
		!object(value) ||
		typeof value.db !== "string" ||
		typeof value.id !== "string" ||
		typeof value.at !== "number" ||
		!Number.isFinite(value.at) ||
		!object(value.row) ||
		!Object.values(value.row).every(
			(column) =>
				column === null || typeof column === "string" || (typeof column === "number" && Number.isFinite(column)),
		)
	)
		throw new Error("Malformed history archive record; the archive was not changed.");
	if (audit) {
		const id = value.row.id;
		if ((typeof id !== "number" && typeof id !== "string") || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
			throw new Error("Malformed history audit id; the archive was not changed.");
	}
	return value as unknown as ArchiveRecord;
}
