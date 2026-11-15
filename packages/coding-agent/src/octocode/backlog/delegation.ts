import type { Backlog } from "./context.ts";
import { BacklogError, type Item } from "./item.ts";

/**
 * The link between a backlog item and the child a parent starts for it (`agent` `item`): the parent holds the item (it
 * claims a claimable one once the call is accepted), the child may update only it (`writes.ts`, by `Actor.item`), and the child's
 * report is noted on it here.
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

/**
 * The item a delegation names, checked and not yet claimed: one this session already holds, or an unheld `todo` or
 * `backlog` item with goal and why that `claimDelegated` can claim; either with no open `dependsOn` item. An epic, an
 * item held by another session, a finished one, one without goal or why, or one still waiting on a prerequisite (a held
 * one too: its prerequisite may have been reopened since the claim) is refused with what to do. With `queue`, a
 * prerequisite still open is no refusal: `waitsOn` names them, for a start that waits for them (`subagents/queued-start.ts`).
 */
export function checkDelegable(
	backlog: Backlog,
	ref: string,
	queue = false,
): { item: Item; claimable: boolean; waitsOn: string[] } {
	const item = backlog.store.get(ref);
	if (!item) throw new BacklogError(`No backlog item ${ref}.`);
	if (item.type === "epic")
		throw new BacklogError(
			`${item.ref} is an epic: it follows its items, so delegate one of them (backlogPlan list underEpic ${item.ref}).`,
		);
	if (item.state !== "todo" && item.state !== "backlog") {
		const held = heldItem(backlog, ref);
		return { item: held, claimable: false, waitsOn: waitingOn(backlog, held, queue) };
	}
	const missing = [!item.goal.trim() && "a goal (the done criterion)", !item.why.trim() && "a why (the reason)"].filter(
		Boolean,
	);
	if (missing.length)
		throw new BacklogError(
			`${item.ref} is ${item.state} and needs ${missing.join(" and ")} before it can be delegated: add ${missing.length > 1 ? "them" : "it"} with backlogPlan edit, then call again.`,
		);
	// Refused here, before the spawn is approved: the claim would refuse it after (`entity-write.ts`, Blocked by).
	return { item, claimable: true, waitsOn: waitingOn(backlog, item, queue) };
}

/** The open `dependsOn` items of `item`: with `queue` they are returned, else an item with any is refused, naming them and how to go on. */
function waitingOn({ store }: Backlog, item: Item, queue: boolean): string[] {
	const open = store.openPrerequisites(item);
	if (open.length && !queue)
		throw new BacklogError(
			`${item.ref} waits on ${open.join(", ")}: start it when ${open.length > 1 ? "they are" : "it is"} done (timer until item ${item.ref} ready), or drop the link with backlogPlan edit dependsOn.`,
		);
	return open;
}

/** Claims a checked unheld item for this session through the ordinary claim (`BacklogStore.update`), as the delegation. */
export function claimDelegated({ store, actor, session }: Backlog, item: Item): Item {
	return store.update(
		item.ref,
		{ state: "ongoing", version: item.version, note: `Claimed for session ${session} by delegating it to a subagent.` },
		actor,
	);
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
