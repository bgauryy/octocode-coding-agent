import { validPid } from "../../utils/process-id.ts";
import { type ProcessRow, readProcessTable } from "./process-table.ts";

/**
 * An ancestry snapshot, before an exit can reparent detached descendants. Fresh by default (a decision to signal);
 * `fresh: false` accepts the shared table of the last second, for a background poll.
 */
export async function descendantRows(
	pid: number | undefined,
	includeRoot = false,
	options: { fresh?: boolean } = {},
): Promise<ProcessRow[]> {
	if (!validPid(pid) || process.platform === "win32") return [];
	const table = await readProcessTable({ fresh: options.fresh ?? true });
	if (!table) return [];
	const children = new Map<number, ProcessRow[]>();
	for (const row of table.rows.values()) {
		if (!row.pid || !row.ppid) continue;
		children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
	}
	const found = new Map<number, ProcessRow>();
	for (let queue = [pid]; queue.length > 0;) {
		const next = queue
			.flatMap((each) => children.get(each) ?? [])
			.filter((row) => !found.has(row.pid) && row.pid !== pid);
		for (const row of next) found.set(row.pid, row);
		queue = next.map((row) => row.pid);
	}
	return [...(includeRoot && table.rows.has(pid) ? [table.rows.get(pid)!] : []), ...found.values()];
}
