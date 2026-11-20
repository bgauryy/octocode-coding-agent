import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import { type Db, tasks } from "../../../../../db/src/api.ts";
import type { Actor } from "../item.ts";
import { getItem } from "../reads.ts";
import { TaskError } from "./reads.ts";

/**
 * Refuses starting a step while another step of the same owner (an item, or a session's scratch list) is ongoing for
 * `actor`: finish or drop that one first. `except` is the step being changed, which may already be ongoing.
 */
export function refuseSecondOngoing(
	db: Db,
	repo: string,
	owner: { itemId: number } | { sessionId: string },
	actor: Actor,
	except?: BacklogTask,
): void {
	const running = tasks
		.listTasks(db, { repo, ...owner, states: ["ongoing"] })
		.find((row) => row.assignee === actor.id && row.seq !== except?.seq);
	if (!running) return;
	throw new TaskError(
		`Step ${toRef(running.seq)} is still ongoing for you: mark it done or dropped before starting another.`,
	);
}

const toRef = (seq: number) => `T${seq}`;

/** The owner key of `task`: its item's row id, or its session id. */
export function ownerKey(db: Db, repo: string, task: BacklogTask): { itemId: number } | { sessionId: string } {
	const { owner } = task;
	if (owner.kind === "session") return { sessionId: owner.id };
	const item = getItem(db, repo, owner.ref);
	if (!item) throw new TaskError(`${owner.ref} no longer exists.`, task);
	return { itemId: item.rowId };
}
