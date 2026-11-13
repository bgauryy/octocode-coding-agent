import { storedText } from "../../../../common/src/sanitize.ts";
import { textResult } from "../shared/util.ts";
import type { Backlog } from "./context.ts";
import { taskLine } from "./task-format.ts";
import { TaskError } from "./tasks/reads.ts";

/** Report one existing step's result; item completion stays a separate, verified operation. */
export function completeStep(
	backlog: Backlog,
	args: { id?: string; note?: string; version?: number },
): ReturnType<typeof textResult> {
	if (!args.id || !/^\s*T\d{1,9}\s*$/i.test(args.id)) throw new TaskError("step needs a task id, e.g. T12.");
	const result = storedText(args.note);
	if (!result.trim()) throw new TaskError("step needs note: the result and check evidence for the completed step.");
	const before = backlog.store.tasks.get(args.id);
	if (!before) throw new TaskError(`No task ${args.id}.`);
	if (before.state === "dropped")
		throw new TaskError(`${before.ref} was dropped: reopen it on the backlog board first.`);
	const task = backlog.store.tasks.update(
		before.ref,
		{ state: "done", result, version: args.version ?? before.version },
		backlog.actor,
	);
	const siblings = backlog.store.tasks.list(
		task.owner.kind === "item" ? { item: task.owner.ref } : { session: task.owner.id },
	);
	const done = siblings.filter((step) => step.state === "done").length;
	const dropped = siblings.filter((step) => step.state === "dropped").length;
	const progress = { done, dropped, open: siblings.length - done - dropped, total: siblings.length };
	return textResult(
		`${task.ref} → done · ${done}/${progress.total} steps done${dropped ? ` (${dropped} dropped)` : ""}\n${taskLine(task)}`,
		{ task, progress },
	);
}
