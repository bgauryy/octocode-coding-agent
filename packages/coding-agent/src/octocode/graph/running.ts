import type { JobRow } from "../../../../db/src/api.ts";
import type { RunningWork, WorkRow } from "../shared/running-work.ts";
import { nodeId, type JobSnap, type JobSource, type WorkGraph } from "./model.ts";

const BASH_ORIGIN = "bash-jobs";

/** The session's background bash jobs as graph jobs: each names its item, so the graph gives it a `serves` edge. */
export const jobsOfRunningWork =
	(work: RunningWork): JobSource =>
	() =>
		work
			.all()
			.filter((row) => row.kind === "bash")
			.map((row): JobSnap => ({
				id: row.id,
				label: row.title,
				state: "running",
				from: BASH_ORIGIN,
				...(row.item === undefined ? {} : { item: row.item }),
			}));

/**
 * The rows with what the graph knows of them: a bash job names the item it serves and the resource it holds (`full-run`),
 * a row that already names its item keeps it. Rows the graph does not know pass through.
 */
export function linkRows(rows: readonly WorkRow[], graph: WorkGraph): WorkRow[] {
	return rows.map((row) => {
		if (row.kind !== "bash") return row;
		const id = nodeId("job", row.id);
		const item = graph.out(id, "serves")[0]?.to.slice("item:".length);
		const resource = graph.out(id, "holds")[0]?.to.slice("resource:".length);
		return {
			...row,
			...(row.item === undefined && item !== undefined ? { item } : {}),
			...(resource === undefined ? {} : { resource }),
		};
	});
}

/**
 * The jobs other sessions run, from the database's job rows: each names its item. The session's own jobs come from
 * `jobsOfRunningWork`, so they are left out here; a row's id carries its agent or session so two sessions' `bash-1` stay apart.
 */
export const jobsOfRows =
	(rows: () => readonly JobRow[], ownSession: string): JobSource =>
	() =>
		rows()
			.filter((row) => row.state === "running" && row.session_id !== ownSession)
			.map((row): JobSnap => ({
				id: `${row.agent ?? row.session_id.slice(0, 8)}/${row.job}`,
				label: row.command.split("\n", 1)[0] ?? row.command,
				state: "running",
				from: BASH_ORIGIN,
				...(row.item === null ? {} : { item: row.item }),
			}));
