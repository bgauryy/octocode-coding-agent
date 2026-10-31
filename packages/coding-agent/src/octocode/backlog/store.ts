import { dbStamp, type AgentDb } from "../agentdb/db.ts";
import { type Note, type BacklogComment, type BacklogAudit, type State } from "@octocodeai/octocode-contracts/snapshot";
import { type Actor, BacklogError, type Item, PRIORITIES, parseRef, priorityName } from "./item.ts";
import type { AddInput, ListQuery, UpdateInput } from "./inputs.ts";
import {
	audit as auditTrail,
	comments as itemComments,
	counts as stateCounts,
	derived as derivedItems,
	getItem,
	list as listItems,
	liveHolder as holderOf,
	noteCount as countNotes,
	notes as itemNotes,
} from "./reads.ts";
import { addItem, COMPLETION_GUIDANCE, removeItem, updateItem } from "./writes.ts";

export { BacklogError, COMPLETION_GUIDANCE, PRIORITIES, parseRef, priorityName };
export type { Actor, Item };
export type { UpdateInput };

/**
 * The per-repository backlog in the shared agent database (`backlog`, `backlog_notes`; schema in src/agentdb). Items are
 * numbered per repository (`B12`); each call is one transaction, so several Octocode processes can work the same board.
 *
 *   backlog   triage inbox: everything an agent proposes lands here
 *   todo      accepted, not started
 *   ongoing   claimed by one session or subagent (the assignee)
 *   done      finished, with a note saying what changed and how it was verified
 *
 * An item has a title, a goal (what done means), where it applies (`paths`), why it matters, the evidence for it and a
 * plan, and a body for whatever else. The store keeps when it was created,
 * last claimed (`started_at`), updated and done. An item may name the item it came from (`from`: a split, follow-up or finding), so the origin lists what came of it.
 * Every update writes a `change` note with what it changed (a replaced text is kept in full), next to the agent's own
 * notes, which say why.
 *
 * The queries live in `reads.ts`, the transactions in `writes.ts`, entity fields in `entities.ts` and
 * `entity-write.ts`, and the item's value types and text rules in `item.ts`.
 */
export class BacklogStore {
	private readonly agentDb: () => AgentDb;
	readonly repo: string;
	private readonly now: () => number;
	constructor(agentDb: () => AgentDb, repo: string, now: () => number = Date.now) {
		this.agentDb = agentDb;
		this.repo = repo;
		this.now = now;
	}

	get revision(): string {
		return dbStamp(this.agentDb().file);
	}

	private get db() {
		return this.agentDb().db;
	}

	get(ref: string | number): Item | undefined {
		return getItem(this.db, this.repo, ref);
	}

	/** The items that came from `item`, in board order. */
	derived(item: Item): Item[] {
		return derivedItems(this.db, this.repo, item);
	}

	/** Items in `states` (every state when unset), ongoing first, then by priority and most recently updated; `total` counts past the limit. */
	list(query: ListQuery = {}): { items: Item[]; total: number } {
		return listItems(this.db, this.repo, query);
	}

	counts(): Record<State, number> {
		return stateCounts(this.db, this.repo);
	}

	/** The newest `limit` notes after skipping `offset` of them, oldest first; a negative `limit` is every note. */
	notes(item: Item, limit = 10, offset = 0): Note[] {
		return itemNotes(this.db, item, limit, offset);
	}

	dispatch(ref: string, version: number, actor: Actor, deliver: (item: Item) => void): void {
		this.agentDb().transaction(() => deliver(this.update(ref, { state: "ongoing", version }, actor)));
	}

	comments(ref: string): BacklogComment[] {
		return itemComments(this.db, this.repo, ref);
	}

	audit(ref?: string, limit = 500, before?: number): BacklogAudit[] {
		return auditTrail(this.db, this.repo, ref, limit, before);
	}

	comment(ref: string, text: string, actor: Actor, version?: number): Item {
		if (!text.trim()) throw new BacklogError("Write a comment before sending.");
		return this.update(ref, { note: text, version }, actor);
	}

	noteCount(item: Item): number {
		return countNotes(this.db, item);
	}

	add(input: AddInput, actor: Actor = { id: input.createdBy }): Item {
		return addItem(this.agentDb(), this.repo, this.now, input, actor);
	}

	/**
	 * Changes an item. `ongoing` claims it for `actor` (refused while another live assignee holds it); leaving
	 * `ongoing` for `backlog`/`todo` releases it; `done` stamps `done_at`. While another live session holds an item,
	 * others may only add a note (the user may force an edit). A subagent may only touch items its parent holds.
	 */
	update(ref: string, input: UpdateInput, actor: Actor): Item {
		return updateItem(this.agentDb(), this.repo, this.now, ref, input, actor);
	}

	/** Deletes an item and its notes. With `actor` (the agent), an item another live session holds is refused. */
	remove(ref: string, version?: number, actor?: Actor): Item {
		return removeItem(this.agentDb(), this.repo, this.now, ref, version, actor);
	}

	/** `assignee` when it is a session whose process still runs, else undefined (a finished session's claim can be taken over). */
	liveHolder(assignee: string): string | undefined {
		return holderOf(this.db, assignee);
	}
}
