import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import { visibleControls } from "../../../../common/src/sanitize.ts";

/** `T3 [ongoing] Goal (B12) — result`: the owner is `(session)` for a session task; `owner: false` omits it (under its item). */
export function taskLine(task: BacklogTask, options: { owner?: boolean } = {}): string {
	const owner = options.owner === false ? "" : ` (${task.owner.kind === "item" ? task.owner.ref : "session"})`;
	const result = task.result ? ` \u2014 ${visibleControls(task.result)}` : "";
	return `${task.ref} [${task.state}] ${visibleControls(task.goal)}${owner}${result}`;
}

/**
 * A step's own why as an indented line, for views that show a step in detail; nothing when it has none (a step under an
 * item then serves the item's why, which those views show).
 */
function taskWhy(task: BacklogTask, indent = "  "): string[] {
	const why = visibleControls(task.reason).replace(/\s+/g, " ").trim();
	return why ? [`${indent}why: ${why}`] : [];
}

/** An item's steps as a block for `get`: a heading with the count, then each step and its own why; empty when none. */
export function taskBlock(tasks: readonly BacklogTask[]): string[] {
	return tasks.length === 0
		? []
		: [
				"",
				`Steps (${tasks.length}):`,
				...tasks.flatMap((task) => [`- ${taskLine(task, { owner: false })}`, ...taskWhy(task)]),
			];
}
