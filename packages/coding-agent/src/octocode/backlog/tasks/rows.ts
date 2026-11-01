import type { BacklogTask, TaskState } from "@octocodeai/octocode-contracts/backlogs";
import type { TaskRow } from "../../agentdb/api.ts";
import { refText } from "../row.ts";

/** `T12`, `t12` or `12` → 12. */
export function parseTaskRef(ref: string): number | undefined {
	const match = /^\s*[tT]?#?(\d{1,9})\s*$/.exec(ref);
	return match ? Number(match[1]) : undefined;
}

/** A task's number as people write it (`T12`). */
const taskRefText = (seq: number) => `T${seq}`;

export const toTask = (row: TaskRow): BacklogTask => ({
	ref: taskRefText(row.seq),
	seq: row.seq,
	rowId: row.id,
	goal: row.goal,
	reason: row.reason,
	state: row.state as TaskState,
	position: row.position,
	owner:
		row.item_seq === null
			? { kind: "session", id: row.session_id ?? "" }
			: { kind: "item", ref: refText(row.item_seq) },
	...(row.assignee ? { assignee: row.assignee } : {}),
	result: row.result,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	...(row.done_at ? { doneAt: row.done_at } : {}),
	version: row.version,
});
