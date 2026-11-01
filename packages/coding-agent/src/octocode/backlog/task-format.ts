import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import { visibleControls } from "../../../../common/src/sanitize.ts";

/** `T3 [ongoing] Goal (B12) — result`: the owner is `(session)` for a session task; `owner: false` omits it (under its item). */
export function taskLine(task: BacklogTask, options: { owner?: boolean } = {}): string {
	const owner = options.owner === false ? "" : ` (${task.owner.kind === "item" ? task.owner.ref : "session"})`;
	const result = task.result ? ` \u2014 ${visibleControls(task.result)}` : "";
	return `${task.ref} [${task.state}] ${visibleControls(task.goal)}${owner}${result}`;
}

/** An item's tasks as a block for `get`: a heading with the count, then one line each; empty when it has none. */
export function taskBlock(tasks: readonly BacklogTask[]): string[] {
	return tasks.length === 0
		? []
		: ["", `Tasks (${tasks.length}):`, ...tasks.map((task) => `- ${taskLine(task, { owner: false })}`)];
}
