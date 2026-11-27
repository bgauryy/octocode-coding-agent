import fs from "node:fs";
import type { Row } from "./rows.ts";
import { openReadOnlyDb } from "./sqlite.ts";

/** What a database file holds, read without writing: its sizes, schema version and rows per table. */
export interface FileReport {
	file: string;
	/** Bytes of the file and of its WAL (0 when there is none). */
	bytes: number;
	walBytes: number;
	version: number;
	/** Rows per table, full-text index tables left out. */
	tables: Record<string, number>;
}

/** Reads `file` on a read-only connection (no migration, no write); undefined when there is no such file. */
export function fileReport(file: string): FileReport | undefined {
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	if (!stat) return undefined;
	const db = openReadOnlyDb(file);
	try {
		const version = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
		const names = db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name",
			)
			.all()
			.map((row) => String(row.name));
		const tables = Object.fromEntries(
			names.map((name) => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as Row).n)]),
		);
		return {
			file,
			bytes: stat.size,
			walBytes: fs.statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0,
			version,
			tables,
		};
	} finally {
		db.close();
	}
}
