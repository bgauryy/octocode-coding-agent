import type { PathMatch } from "@octocodeai/octocode-contracts/backlogs";
import { untilAborted } from "@octocodeai/octocode-common/abort";
import {
	type Note,
	type NoteKind,
	type BacklogComment,
	type BacklogAudit,
	type State,
	deriveEpicState,
} from "@octocodeai/octocode-contracts/snapshot";
import {
	type AgentDb,
	type AgentRun,
	agentRuns,
	backlog,
	itemHandoffs,
	dbStamp,
	archivedAudits,
	transactionWhenReady,
	sharedDbWriter,
} from "../../../../db/src/api.ts";
import { historyWindows } from "../../storage/retention.ts";
import { TaskStore } from "./tasks/store.ts";
import { type Actor, BacklogError, type Item, PRIORITIES, parseRef, priorityName } from "./item.ts";
import type { AddInput, ListQuery, UpdateInput } from "./inputs.ts";
import {
	audit as auditTrail,
	comments as itemComments,
	counts as stateCounts,
	derived as derivedItems,
	getItem,
	list as listItems,
	stat as itemStats,
	type ItemStats,
	liveHolder as holderOf,
	noteCount as countNotes,
	notes as itemNotes,
} from "./reads.ts";
import { type RankInput, rankItem } from "./rank.ts";
import { addItem, COMPLETION_GUIDANCE, updateItem } from "./writes.ts";
import { type ItemMarks, itemMarks, reviewNeeded } from "./marks.ts";
import { RELEASE_AFTER_MS, releasable } from "./release.ts";
import type { BacklogCounts } from "./counts.ts";

export { BacklogError, COMPLETION_GUIDANCE, PRIORITIES, parseRef, priorityName };
export { TaskError } from "./tasks/reads.ts";
export type { Actor, Item };
export type { UpdateInput };

/**
 * The per-repository backlog in the shared agent database (`backlog`, `backlog_notes`; schema in packages/db). Items are
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
	/** The repository's tasks: small steps under an item or a session (`backlog_tasks`). */
	readonly tasks: TaskStore;
	constructor(agentDb: () => AgentDb, repo: string, now: () => number = Date.now) {
		this.agentDb = agentDb;
		this.repo = repo;
		this.now = now;
		this.tasks = new TaskStore(agentDb, repo, now);
	}

	/** Admit one synchronous store mutation without waiting on the calling thread for a peer's write lock. */
	transactionWhenReady<T>(write: () => T, signal?: AbortSignal): Promise<T> {
		return transactionWhenReady(this.agentDb(), write, signal);
	}

	/**
	 * The state to show for `item`: an epic's is derived from its child items (all done is done, any ongoing is ongoing, any
	 * todo is todo, else backlog; an epic without children keeps its stored state), any other item's is its own.
	 */
	epicState(item: Item): State {
		return item.type === "epic"
			? deriveEpicState(item.state, backlog.childStates(this.db, item.rowId) as State[])
			: item.state;
	}

	get revision(): string {
		return dbStamp(this.agentDb().file);
	}

	/** Item titles for transcript reference rendering, without bodies, links, comments or completion history. */
	titles(): ReadonlyMap<string, string> {
		return new Map(backlog.itemTitles(this.db, this.repo).map(({ seq, title }) => [`B${seq}`, title]));
	}

	private get db() {
		return this.agentDb().db;
	}

	get(ref: string | number): Item | undefined {
		return getItem(this.db, this.repo, ref);
	}

	/** The runs of agents started for `item` (`agent_runs`, newest first). */
	runs(item: Item): AgentRun[] {
		return agentRuns.forItem(this.db, this.repo, item.seq);
	}

	derived(item: Item): Item[] {
		return derivedItems(this.db, this.repo, item);
	}

	/** What a line about each of `items` adds (open prerequisites and steps, a stale claim), by ref; `self` and `parents` are the reader's sessions. */
	marks(items: readonly Item[], self?: string, parents?: ReadonlySet<string>): Map<string, ItemMarks> {
		return itemMarks(this.db, this.repo, items, self, parents);
	}

	/** The `dependsOn` items of `item` that are missing or not done (a closed one counts as done), in link order. */
	openPrerequisites(item: Item): string[] {
		return backlog.openPrerequisites(this.db, this.repo, item.seq);
	}

	/** Done parents and dependants that need a second look because `item` is not done (`B3 (parent of B7)`). */
	reviewNeeded(item: Item): string[] {
		return reviewNeeded(this.db, this.repo, item);
	}

	/** Items in `states` (every state when unset), ongoing first, then by priority and most recently updated; `total` counts past the limit. */
	list(query: ListQuery = {}): { items: Item[]; total: number; pathMatches?: Map<string, PathMatch> } {
		return listItems(this.db, this.repo, query);
	}

	/** The counts of what `list(query)` matches, by state, priority and type, with no rows. */
	stat(query: ListQuery = {}): ItemStats {
		return itemStats(this.db, this.repo, query);
	}

	/** Items per state and epics per derived state (`BacklogCounts`): what the footer shows and the board's header repeats. */
	counts(): BacklogCounts {
		return stateCounts(this.db, this.repo);
	}

	/** The newest `limit` notes after skipping `offset` of them, oldest first; a negative `limit` is every note. */
	notes(item: Item, limit = 10, offset = 0, kind?: NoteKind): Note[] {
		return itemNotes(this.db, item, limit, offset, kind);
	}

	/** Claims `ref` as ongoing and hands the claimed item to `deliver`, in one transaction; `fields` are set in the same update. */
	dispatch(
		ref: string,
		version: number,
		actor: Actor,
		deliver: (item: Item) => void,
		fields: Pick<UpdateInput, "why" | "goal"> = {},
	): void {
		this.agentDb().transaction(() => deliver(this.update(ref, { ...fields, state: "ongoing", version }, actor)));
	}

	comments(ref: string): BacklogComment[] {
		return itemComments(this.db, this.repo, ref);
	}

	/** The newest `limit` audit rows, oldest first: the table and, within the keep window (`historyWindows`), the history archive. */
	audit(ref?: string, limit = 500, before?: number): BacklogAudit[] {
		const agentDb = this.agentDb();
		const archived = archivedAudits(
			agentDb,
			this.now(),
			this.repo,
			ref,
			before,
			Math.min(500, limit),
			historyWindows(),
		);
		return auditTrail(agentDb.db, this.repo, ref, limit, before, archived);
	}

	/** Reads archived history off the calling thread, preserving live rows captured before asynchronous housekeeping. */
	async auditAsync(ref?: string, limit = 500, before?: number, signal?: AbortSignal): Promise<BacklogAudit[]> {
		signal?.throwIfAborted();
		const agent = this.agentDb();
		const size = Math.max(1, Math.min(500, Math.floor(limit)));
		const current = backlog.auditRows(agent.db, this.repo, ref, before, size);
		const request = sharedDbWriter({
			file: agent.file,
			mirrorFile: agent.mirrorFile,
			archiveDir: agent.archiveDir,
			privateParent: false,
		}).archivedAudits({ now: this.now(), repo: this.repo, ref, before, limit: size, windows: historyWindows() });
		const archived = await untilAborted(request, signal);
		return auditTrail(agent.db, this.repo, ref, size, before, archived, current);
	}

	comment(ref: string, text: string, actor: Actor, version?: number): Item {
		if (!text.trim()) throw new BacklogError("Write a comment before sending.");
		return this.update(ref, { note: text, version }, actor);
	}

	noteCount(item: Item, kind?: NoteKind): number {
		return countNotes(this.db, item, kind);
	}

	add(input: AddInput, actor: Actor = { id: input.createdBy }): Item {
		return addItem(this.agentDb(), this.repo, this.now, input, actor);
	}

	/**
	 * Changes an item. `ongoing` claims it for `actor` (refused while another live assignee holds it); leaving
	 * `ongoing` for `backlog`/`todo` releases it; `done` stamps `done_at`. While another live session holds an item,
	 * others may only add a note (the user may force an edit). A subagent may only touch items its parent holds.
	 */
	/** Places `ref` in its column by a rank between the cards `after` and `before` (see `rankItem`); one row changes in the usual case. */
	rank(ref: string, input: RankInput, actor: Actor): Item {
		return rankItem(this.agentDb(), this.repo, this.now, ref, input, actor);
	}

	update(ref: string, input: UpdateInput, actor: Actor): Item {
		return updateItem(this.agentDb(), this.repo, this.now, ref, input, actor);
	}

	/**
	 * Returns to todo, with a note naming the ended holder, each ongoing item whose holder session ended without a graceful
	 * exit, that no child run works on and that sat idle for the window (`RELEASE_AFTER_MS`). Claims of `actor` and of its
	 * coordinators are never taken. Returns the refs released.
	 */
	releaseEnded(actor: Actor): string[] {
		const items = this.list({ states: ["ongoing"] }).items;
		const hours = Math.round(RELEASE_AFTER_MS / 3_600_000);
		const released: string[] = [];
		for (const item of releasable(items, this.marks(items, actor.id, actor.owners), this.now())) {
			try {
				this.update(
					item.ref,
					{
						state: "todo",
						note: `Returned to todo: holder ${item.assignee} ended and the claim sat idle for over ${hours} hours.`,
					},
					actor,
				);
				released.push(item.ref);
			} catch (error) {
				// Another session changed or claimed the item meanwhile: its claim stands.
				if (!(error instanceof BacklogError)) throw error;
			}
		}
		return released;
	}

	/** `assignee` when it is a session whose process still runs, else undefined (a finished session's claim can be taken over). */
	liveHolder(assignee: string, timer = false): string | undefined {
		return holderOf(this.db, assignee, timer);
	}

	/** Lets running subagent `agent`, started by `by`, update `item` besides its start item (`agent` `message` with `item`). */
	hand(item: Pick<Item, "rowId">, agent: string, by: string): void {
		itemHandoffs.grant(this.db, agent, item.rowId, by, this.now());
	}

	/** Takes back `item` from `agent`, or every item handed to it when its run ends. */
	unhand(agent: string, item?: Pick<Item, "rowId">): void {
		itemHandoffs.revoke(this.db, agent, item?.rowId);
	}
}
