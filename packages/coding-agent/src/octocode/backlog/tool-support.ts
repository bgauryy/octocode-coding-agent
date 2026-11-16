import { type Completion, EntityFields, type EntityInput } from "@octocodeai/octocode-contracts/backlogs";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { exclusive } from "../shared/locks.ts";
import { withOperationKey } from "./completion-key.ts";
import type { Item } from "./item.ts";
import { completionInput } from "./tool-arguments.ts";

const queued = exclusive((run: () => Promise<unknown>) => run());

/**
 * Runs one store write of either backlog tool after the writes called before it. Reads (`get`, `list`) do not take
 * this lock; within one message the loop orders them (`concurrency`: a read is shared, a write exclusive), so a read
 * written after a write sees it.
 */
export const oneWrite = <R>(run: () => Promise<R>): Promise<R> => queued(run) as Promise<R>;

/** An operationKey names one completion: its replay says it was applied before, and whether the item moved on since. */
export function replayText(item: Item, done: Completion): string {
	const head = `Completion ${visibleControls(done.operationKey)} of ${item.ref} was already recorded (${new Date(done.at).toISOString()}); nothing was written.`;
	if (item.state !== "done")
		return `${head} ${item.ref} has changed since: it is now ${item.state}. Close it with a new operationKey.`;
	const latest = item.completions.at(-1);
	return latest && latest.id !== done.id ? `${head} A later completion (${latest.id}) replaced it.` : head;
}

/** The call with its completion mapped to the stored shape and its retry key filled in: an explicit one wins, else derived from item and content. */
export function keyed<P extends { id?: string; completion?: unknown }>(
	p: P,
): Omit<P, "completion"> & { completion?: NonNullable<EntityInput["completion"]> } {
	const { completion, ...rest } = p;
	return completion === undefined ? rest : { ...rest, completion: withOperationKey(completionInput(completion), p.id) };
}

/** The entity fields (type, parent, dependencies, links, completion, version) a call names. */
export function entities(p: EntityInput): EntityInput {
	return Object.fromEntries(
		Object.keys(EntityFields)
			.filter((key) => p[key as keyof EntityInput] !== undefined)
			.map((key) => [key, p[key as keyof EntityInput]]),
	);
}
