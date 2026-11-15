import { renderInstruction } from "../../core/prompt-template.ts";
import type { Backlog } from "./context.ts";
import type { Item } from "./item.ts";

/** The items that depend on `ref` in `states`, epics aside (they follow their items), in board order: one listing. */
function dependents({ store }: Backlog, ref: string, states: Item["state"][], blocked?: boolean): Item[] {
	return store
		.list({ dependsOn: [ref], states, ...(blocked === undefined ? {} : { blocked }) })
		.items.filter((item) => item.type !== "epic");
}

/** `ref` was closed without completion: which unstarted dependents can start now, and what each other one still waits on. */
function closedNotice(backlog: Backlog, ref: string): string | undefined {
	const ready = dependents(backlog, ref, ["backlog", "todo"], false).map((item) => item.ref);
	const still = dependents(backlog, ref, ["backlog", "todo"], true);
	if (!ready.length && !still.length) return undefined;
	const marks = backlog.store.marks(still);
	const waits = still.map((item) =>
		renderInstruction("notices/subagents/item-waits.md", {
			ref: item.ref,
			open: (marks.get(item.ref)?.blockedBy ?? []).join(", "),
		}).trim(),
	);
	return renderInstruction("notices/subagents/item-closed.md", {
		ref,
		ready: ready.join(", "),
		several: ready.length > 1,
		waits: waits.join(" "),
	}).trim();
}

/**
 * What the end of `ref` means for the items that wait on it, for the coordinator: done, the unstarted items that now
 * wait on nothing; closed, those and what the others still wait on; still open after its owner child `owner` stopped
 * working on it, the open items left waiting and what to do: the owner ended, or it `lingers` (still reachable, so a
 * second child waits until it is stopped). Undefined when nothing depends on it, or it is open with no owner gone.
 */
export function graphNotice(
	backlog: Backlog,
	ref: string,
	owner?: string,
	lingers = false,
	queued: ReadonlySet<string> = new Set(),
): string | undefined {
	const item = backlog.store.get(ref);
	if (!item) return undefined;
	if (item.state === "done" && item.closed) return closedNotice(backlog, item.ref);
	if (item.state === "done") {
		// An item a queued child waits for starts by itself: its started notice (`startedNotice`) replaces this one.
		const ready = dependents(backlog, item.ref, ["backlog", "todo"], false)
			.map((each) => each.ref)
			.filter((each) => !queued.has(each));
		if (!ready.length) return undefined;
		return renderInstruction("notices/subagents/item-ready.md", {
			ready: ready.join(", "),
			several: ready.length > 1,
			done: item.ref,
		}).trim();
	}
	if (owner === undefined) return undefined;
	const waiting = dependents(backlog, item.ref, ["backlog", "todo", "ongoing"]).map((each) => each.ref);
	if (!waiting.length) return undefined;
	return renderInstruction(`notices/subagents/item-owner-${lingers ? "lingers" : "ended"}.md`, {
		ref: item.ref,
		child: owner,
		waiting: waiting.join(", "),
		several: waiting.length > 1,
	}).trim();
}

/** The `graphNotice` line of a write that completed or closed an item (`before` was open); never throws, since the write succeeded. */
export function endedNotice(
	backlog: Backlog,
	after: Item,
	before: Item | undefined,
	/** The items a queued child will start by itself once `ref` is done (the subagents domain answers). */
	queued?: (ref: string) => ReadonlySet<string>,
): string {
	if (after.state !== "done" || before?.state === "done") return "";
	try {
		const notice = graphNotice(backlog, after.ref, undefined, false, queued?.(after.ref));
		return notice ? `\n${notice}` : "";
	} catch {
		return "";
	}
}

/** What the coordinator is told when a queued child started by itself: `after` names what it waited for (`B12`, `agent:sly-mantle`). */
export function startedNotice(child: string, item: string | undefined, after: readonly string[]): string {
	return renderInstruction("notices/subagents/item-started.md", { child, item, after: after.join(", ") }).trim();
}

/** What the coordinator is told when a queued child is held: `why` names the prerequisites that failed, or the refusal at its start. */
export function heldNotice(child: string, item: string | undefined, why: string): string {
	return renderInstruction("notices/subagents/item-held.md", { child, item, why }).trim();
}
