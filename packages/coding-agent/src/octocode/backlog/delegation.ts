import type { Backlog } from "./context.ts";
import { BacklogError, type Item } from "./item.ts";

/**
 * The link between a backlog item and the child a parent starts for it (`agent` `item`): the parent must hold the item,
 * the child may update only it (`writes.ts`, by `Actor.item`), and the child's report is noted on it here.
 */

/** The item `ref` names, when this session holds it (ongoing, assigned to it); any other state is refused with why. */
export function heldItem({ store, session }: Backlog, ref: string): Item {
	const item = store.get(ref);
	if (!item) throw new BacklogError(`No backlog item ${ref}.`);
	if (item.state !== "ongoing" || !item.assignee)
		throw new BacklogError(`${item.ref} is ${item.state}, not held by this session: claim it (ongoing) first.`);
	if (item.assignee !== session)
		throw new BacklogError(`${item.ref} is held by ${item.assignee}, not by this session: claim it (ongoing) first.`);
	return item;
}

/** What the parent knows about a child's report once it arrived; the words themselves stay in the report. */
export interface ChildReport {
	/** The child's agent id. */
	agent: string;
	/** The outcome word the report led with, if any (`failed` for a run whose model call failed). */
	/** The report's outcome word (`instructions/report.ts` names them); absent when the child gave none. */
	outcome?: string;
	/** The whole report on disk, when it was long enough to be saved. */
	file?: string;
	/** The checks the report's verification section names; undefined when it has no such section. */
	checks?: readonly string[];
}

/**
 * Notes a child's report on its item, as the parent: the outcome word, the saved report's path and the agent. A `done`
 * report on an item closed with a passed completion records the named checks as that completion's evidence (or that
 * none were named); a `done` report without such a completion says so, since the status alone is the child's word.
 */
export function attachReport(backlog: Backlog, ref: string, report: ChildReport): Item {
	const { store, actor } = backlog;
	const item = store.get(ref);
	if (!item) throw new BacklogError(`No backlog item ${ref}.`);
	const parts = [`Report from ${report.agent}: ${report.outcome ?? "no outcome word"}.`];
	if (report.file) parts.push(`Saved at ${report.file}.`);
	if (report.outcome === "done") {
		const passed = item.state === "done" && item.completions.at(-1)?.verification.status === "passed";
		if (!passed) parts.push(`${item.ref} is ${item.state} without a passed completion.`);
		else if (report.checks?.length)
			parts.push(`Completion evidence, the checks its report names: ${report.checks.join("; ")}.`);
		else parts.push("Completion evidence: no checks named.");
	}
	return store.update(item.ref, { note: parts.join(" ") }, actor);
}
