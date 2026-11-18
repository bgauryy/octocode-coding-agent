import type { WorkRow } from "../shared/running-work.ts";
import { type Item, parseRef } from "./item.ts";
import type { BacklogStore } from "./store.ts";

/**
 * What this process still runs that an item's `done` must wait for, as the host reads it. Every read is of this session
 * (or this child) only: another session's children, jobs and reservations are its own to release.
 */
export interface Holdings {
	/** The children running now, by name, with the item each was started on. */
	children(): ReadonlyMap<string, string>;
	/** The background bash jobs and timers running now (`item` of a job, `items` a timer's note names). */
	work(): readonly WorkRow[];
	/** The paths this agent reserves, as `coordinate` lists them (a trailing `/` marks a tree). */
	locks(): readonly string[];
	/** The isolated worktrees kept for item `ref` of the checkout at `cwd`: their agent ids. */
	worktrees(ref: string, cwd: string): readonly string[];
}

/** The items searched below an item for a child that still works for it; a board is far smaller. */
const DERIVED_LIMIT = 500;

/** `item`'s refs and those of every item derived from it: its sub-items at any depth and the items that came from it, from them too. */
function derivedRefs(store: Pick<BacklogStore, "list" | "derived">, item: Item): Map<string, string> {
	/** Each ref with the one it was reached from. */
	const found = new Map<string, string>();
	const queue = [item];
	for (let at = queue.shift(); at && found.size < DERIVED_LIMIT; at = queue.shift())
		for (const next of [...store.list({ parentId: at.ref }).items, ...store.derived(at)]) {
			if (next.ref === item.ref || found.has(next.ref)) continue;
			found.set(next.ref, at.ref);
			queue.push(next);
		}
	return found;
}

const trimmed = (path: string): string => path.replace(/^\.\//, "").replace(/\/+$/, "");

/** The reservations among `locks` that cover an entry of `paths`, or sit inside one (either way the item's files are held). */
export function overlapping(locks: readonly string[], paths: readonly string[]): string[] {
	const wanted = paths.map(trimmed).filter(Boolean);
	return locks.filter((lock) => {
		const held = trimmed(lock);
		return wanted.some((path) => path === held || path.startsWith(`${held}/`) || held.startsWith(`${path}/`));
	});
}

const servesItem = (ref: string | undefined, seq: number): boolean => ref !== undefined && parseRef(ref) === seq;

/**
 * The refusal for `done` on `item` when this session still runs children linked to it or to items derived from it, bash
 * jobs or timers started for it, holds reservations on its paths or keeps worktrees made for it; undefined when none.
 * It names each thing to release. `close` is never asked: closing ends an item whose work is dropped.
 */
export function doneRefusal(
	store: Pick<BacklogStore, "list" | "derived">,
	item: Item,
	holdings: Holdings,
	cwd: string,
): string | undefined {
	const below = derivedRefs(store, item);
	const running = holdings.children();
	const holds: string[] = [];
	for (const [child, ref] of running) {
		if (ref === item.ref)
			holds.push(`child ${child} works on ${item.ref}: wait for its report or stop it (\`coordinate\` action stop)`);
		else if (below.has(ref))
			holds.push(
				`child ${child} works on ${ref}, derived from ${item.ref}: wait for its report or stop it (\`coordinate\` action stop)`,
			);
	}
	for (const row of holdings.work()) {
		if (row.kind === "bash" && servesItem(row.item, item.seq))
			holds.push(`bash job ${row.id} runs for ${item.ref}: let it end or stop it`);
		if (row.kind === "timer" && row.items?.some((ref) => servesItem(ref, item.seq)))
			holds.push(`timer ${row.id} was set for ${item.ref}: cancel it (\`wait\` op off)`);
	}
	for (const lock of overlapping(holdings.locks(), item.paths))
		holds.push(`reservation ${lock} covers the item's paths: release it (\`coordinate\` action unlock)`);
	for (const worktree of holdings.worktrees(item.ref, cwd))
		if (!running.has(worktree))
			holds.push(
				`worktree ${worktree} was made for ${item.ref}: merge it (\`coordinate\` action merge) or ask the user to discard it`,
			);
	if (holds.length === 0) return undefined;
	return `${item.ref} was not completed: this session still holds work for it. Release: ${holds.join("; ")}. Then mark it done again. To end the item without finishing that work, close it (kind obsolete, duplicate or wont_do).`;
}
