import { dbStamp } from "../agentdb/db.ts";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import {
	EntityFieldsSchema,
	type EntityInput,
	type ItemType,
	type BacklogRef,
	type Completion,
	type WorkLink,
} from "./model.ts";
import { USER_AUTHOR } from "../agentdb/author.ts";
import type { AgentDb } from "../agentdb/db.ts";
import { sessionRunningPid } from "../agentdb/liveness.ts";
import { readMeta, writeMeta } from "../agentdb/meta.ts";
import { redactData, storedSecret, storedText, visibleControls } from "../shared/sanitize.ts";
import { cutText } from "../shared/util.ts";
import { type Row, refText, toItem } from "./row.ts";

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
 */

import {
	STATES,
	type State,
	type Note,
	type NoteKind,
	type BacklogComment,
	type BacklogAudit,
} from "@octocodeai/octocode-contacts/snapshot";
export { STATES, type State, type Note } from "@octocodeai/octocode-contacts/snapshot";
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
type Priority = (typeof PRIORITIES)[number];

export interface Item {
	type: ItemType;
	parentId?: string;
	dependsOn: BacklogRef[];
	links: WorkLink[];
	completions: Completion[];
	reason: string;
	/** Database row id (notes hang from it). */
	rowId: number;
	seq: number;
	/** `B<seq>`. */
	ref: string;
	title: string;
	/** What done means: the observable result or check that closes the item. */
	goal: string;
	body: string;
	/** Repo-relative files, directories or components the work touches. */
	paths: string[];
	/** Why it matters: the problem and who it affects. */
	why: string;
	/** Observations that justify it: `path:line — what it shows`, a command and its result, or a link. */
	evidence: string[];
	/** The intended approach and steps. */
	plan: string;
	state: State;
	priority: number;
	tags: string[];
	assignee?: string;
	createdBy: string;
	sourceSession?: string;
	createdAt: number;
	updatedAt: number;
	/** When the item was last claimed (moved to ongoing, or taken over); kept when it is done, cleared when released. */
	startedAt?: number;
	doneAt?: number;
	/** The item this one came from, by number (`B<from>`). */
	from?: number;
	version: number;
}

/** Who is acting: the id written as assignee and note author, and for a subagent the sessions of its parent. */
export interface Actor {
	id: string;
	kind?: "human" | "agent";
	/** Set for a subagent: its parent's sessions, the only assignees whose items it may update (it never claims). */
	owners?: ReadonlySet<string>;
}

export class BacklogError extends Error {
	readonly current?: Item;
	constructor(message: string, current?: Item) {
		super(message);
		this.current = current;
	}
}

/** Items with the number of the item each came from; filters and order use the `b.` alias. */
const SELECT = "SELECT b.*, f.seq AS from_seq FROM backlog b LEFT JOIN backlog f ON f.id = b.from_item";

const tagText = (tags: readonly string[]) => (tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "none");
const listText = (entries: readonly string[]) => (entries.length ? entries.join(", ") : "none");

/** A text field's change: the old text is kept in full, so a replacement loses nothing. */
const replaced = (name: string, before: string) => (before ? `${name} replaced; it was:\n${before}` : `${name} added`);

/** The change note for one update: every field that changed, old → new; a replaced text is kept in full. */
function changeText(before: Item, after: Item): string {
	const parts: string[] = [];
	if (after.state !== before.state) parts.push(`state ${before.state} → ${after.state}`);
	if (after.assignee !== before.assignee)
		parts.push(`assignee ${before.assignee ?? "none"} → ${after.assignee ?? "none"}`);
	if (after.priority !== before.priority)
		parts.push(`priority ${priorityName(before.priority)} → ${priorityName(after.priority)}`);
	if (after.tags.join(" ") !== before.tags.join(" "))
		parts.push(`tags ${tagText(before.tags)} → ${tagText(after.tags)}`);
	if (after.from !== before.from) parts.push(`from ${refText(before.from)} → ${refText(after.from)}`);
	if (after.title !== before.title) parts.push(`title was "${before.title}"`);
	if (after.goal !== before.goal) parts.push(before.goal ? `goal was "${before.goal}"` : "goal added");
	if (after.paths.join("\n") !== before.paths.join("\n"))
		parts.push(`paths ${listText(before.paths)} → ${listText(after.paths)}`);
	if (after.why !== before.why) parts.push(replaced("why", before.why));
	if (after.evidence.join("\n") !== before.evidence.join("\n"))
		parts.push(replaced("evidence", before.evidence.join("\n")));
	if (after.plan !== before.plan) parts.push(replaced("plan", before.plan));
	if (after.body !== before.body) parts.push(replaced("body", before.body));
	return parts.join(" · ");
}

/** A title as stored: one line (a title is a one-line summary; a newline would break lists, the board and the export). */
const storedTitle = (title: string | undefined): string => storedText(title).replace(/\s+/g, " ");

/** `B12`, `b12`, `#12` or `12` → 12. */
export function parseRef(ref: string): number | undefined {
	const match = /^\s*(?:[bB]|#)?(\d{1,9})\s*$/.exec(ref);
	return match ? Number(match[1]) : undefined;
}

/** Tags as stored: lower-case words of letters, digits, `.`, `_`, `-`, without a leading `#`, deduplicated. */
function cleanTags(tags: readonly string[]): string[] {
	const words = tags
		.map((tag) =>
			cutText(
				tag
					.trim()
					.replace(/^#+/, "")
					.toLowerCase()
					.replace(/[^\p{L}\p{N}._-]+/gu, "-")
					.replace(/^-+|-+$/g, ""),
				32,
				{ chars: true },
			),
		)
		.filter(Boolean);
	return [...new Set(words)];
}

/** A list as stored: one entry per line, each entry one trimmed line, empty entries and repeats dropped. */
function cleanList(entries: readonly string[]): string[] {
	return [...new Set(entries.map((entry) => storedText(entry).replace(/\s+/g, " ")).filter(Boolean))];
}

/**
 * Refuses text that looks like a credential (the backlog is plain text in the home database). Checked on the
 * sanitized text, the form that is stored, so an invisible character cannot split a token past the check.
 */
export function refuseSecrets(fields: Record<string, string | readonly string[] | undefined>): void {
	const found = storedSecret(fields);
	if (found) throw new BacklogError(`Not stored: the ${found.name} ${found.problem.replace(/^it /, "")}.`);
}

export const priorityName = (priority: number): Priority => PRIORITIES[priority] ?? "p2";

interface AddInput extends EntityInput {
	note?: string;
	title: string;
	goal?: string;
	body?: string;
	paths?: readonly string[];
	why?: string;
	evidence?: readonly string[];
	plan?: string;
	state?: State;
	priority?: number;
	tags?: readonly string[];
	/** The item this one came from (`B12`). */
	from?: string;
	createdBy: string;
	sourceSession?: string;
}

export interface UpdateInput extends EntityInput {
	title?: string;
	goal?: string;
	body?: string;
	paths?: readonly string[];
	why?: string;
	evidence?: readonly string[];
	plan?: string;
	state?: State;
	priority?: number;
	tags?: readonly string[];
	/** The item this one came from (`B12`); null clears the link. */
	from?: string | null;
	note?: string;
	/** Refuse when the item changed since this version was read (a board holding a stale copy). */
	version?: number;
	/** The user's own edit: may change an item another live session holds (claiming it is still refused). */
	force?: boolean;
}

interface ListQuery {
	states?: readonly State[];
	query?: string;
	/** Only the items that came from this one (`B12`). */
	from?: string;
	limit?: number;
	offset?: number;
}

const ORDER = `CASE b.state WHEN 'ongoing' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 ELSE 3 END, b.priority, b.updated_at DESC, b.seq DESC`;

const SEARCHED = ["title", "goal", "body", "paths", "why", "evidence", "plan"] as const;

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

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
		const seq = typeof ref === "number" ? ref : parseRef(ref);
		if (seq === undefined) return undefined;
		const row = this.db.prepare(`${SELECT} WHERE b.repo_key = ? AND b.seq = ?`).get(this.repo, seq) as
			| Row<State>
			| undefined;
		return row ? this.enrich(toItem(row)) : undefined;
	}

	/** The items that came from `item`, in board order. */
	derived(item: Item): Item[] {
		const rows = this.db
			.prepare(`${SELECT} WHERE b.from_item = ? ORDER BY ${ORDER}`)
			.all(item.rowId) as unknown as Row<State>[];
		return rows.map((row) => this.enrich(toItem(row)));
	}

	/** The row id of the item `ref` names, refused when it is missing, is `item` itself, or already comes from `item`. */
	private origin(ref: string, item?: Item): number {
		const target = this.get(ref);
		if (!target) throw new BacklogError(`No backlog item ${visibleControls(ref)} to link from.`);
		if (!item) return target.rowId;
		if (target.rowId === item.rowId) throw new BacklogError(`${item.ref} cannot come from itself.`);
		const seen = new Set<number>();
		for (let at: Item | undefined = target; at?.from !== undefined && !seen.has(at.seq); at = this.get(at.from)) {
			seen.add(at.seq);
			if (at.from === item.seq)
				throw new BacklogError(`${target.ref} already comes from ${item.ref}: the link would make a loop.`);
		}
		return target.rowId;
	}

	/** Items in `states` (every state when unset), ongoing first, then by priority and most recently updated; `total` counts past the limit. */
	list(query: ListQuery = {}): { items: Item[]; total: number } {
		const states = query.states?.length ? [...new Set(query.states)] : [...STATES];
		const where = [`b.repo_key = ?`, `b.state IN (${states.map(() => "?").join(", ")})`];
		const args: Array<string | number> = [this.repo, ...states];
		const text = query.query?.trim();
		if (text) {
			// Every text field matches any substring (so `backlog/store` finds a path); a tag matches only whole (`ui` is not found in `build`), with or without `#`.
			where.push(
				`(${SEARCHED.map((column) => `b.${column} LIKE ? ESCAPE '\\'`).join(" OR ")} OR (' ' || b.tags || ' ') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM backlog_completions c WHERE c.item = b.id AND c.payload LIKE ? ESCAPE '\\'))`,
			);
			const like = `%${likeEscape(text)}%`;
			args.push(...SEARCHED.map(() => like), `% ${likeEscape(text.replace(/^#+/, ""))} %`, like);
		}
		if (query.from !== undefined) {
			where.push("b.from_item = ?");
			args.push(this.origin(query.from));
		}
		const clause = where.join(" AND ");
		const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM backlog b WHERE ${clause}`).get(...args) as { n: number })
			.n;
		const limit = query.limit === undefined ? -1 : Math.max(0, Math.floor(query.limit));
		const rows = this.db
			.prepare(`${SELECT} WHERE ${clause} ORDER BY ${ORDER} LIMIT ? OFFSET ?`)
			.all(...args, limit, query.offset ?? 0) as unknown as Row<State>[];
		return { items: rows.map((row) => this.enrich(toItem(row))), total };
	}

	counts(): Record<State, number> {
		const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
		const rows = this.db
			.prepare("SELECT state, COUNT(*) AS n FROM backlog WHERE repo_key = ? GROUP BY state")
			.all(this.repo) as Array<{ state: State; n: number }>;
		for (const row of rows) counts[row.state] = row.n;
		return counts;
	}

	/** The newest `limit` notes after skipping `offset` of them, oldest first; a negative `limit` is every note. */
	notes(item: Item, limit = 10, offset = 0): Note[] {
		const rows = this.db
			.prepare(
				"SELECT at, author, kind, text FROM backlog_notes WHERE item = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?",
			)
			.all(item.rowId, limit, offset) as unknown as Note[];
		return rows.reverse().map((row) => ({ at: row.at, author: row.author, kind: row.kind, text: row.text }));
	}

	dispatch(ref: string, version: number, actor: Actor, deliver: (item: Item) => void): void {
		this.agentDb().transaction(() => deliver(this.update(ref, { state: "ongoing", version }, actor)));
	}

	comments(ref: string): BacklogComment[] {
		const item = this.get(ref);
		if (!item) throw new BacklogError(`No backlog item ${ref}.`);
		return (
			this.db
				.prepare("SELECT id, at, author, text FROM backlog_comments WHERE item = ? ORDER BY id")
				.all(item.rowId) as unknown as Array<{ id: number; at: number; author: string; text: string }>
		).map((row) => ({ ...row, backlogId: item.ref }));
	}

	audit(ref?: string, limit = 500, before?: number): BacklogAudit[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM backlog_audits WHERE repo_key = ? AND (? IS NULL OR backlog_id = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
			)
			.all(
				this.repo,
				ref ?? null,
				ref ?? null,
				before ?? null,
				before ?? null,
				Math.max(1, Math.min(500, Math.floor(limit))),
			) as Array<Record<string, string | number | null>>;
		return redactData(
			rows.reverse().map((row) => ({
				id: Number(row.id),
				backlogId: String(row.backlog_id),
				at: Number(row.at),
				actor: JSON.parse(String(row.actor)),
				action: String(row.action),
				entity: String(row.entity),
				before: row.before_value ? JSON.parse(String(row.before_value)) : null,
				after: row.after_value ? JSON.parse(String(row.after_value)) : null,
			})),
		);
	}

	comment(ref: string, text: string, actor: Actor, version?: number): Item {
		if (!text.trim()) throw new BacklogError("Write a comment before sending.");
		return this.update(ref, { note: text, version }, actor);
	}

	noteCount(item: Item): number {
		return (
			this.db.prepare("SELECT COUNT(*) AS n FROM backlog_notes WHERE item = ?").get(item.rowId) as {
				n: number;
			}
		).n;
	}

	add(input: AddInput, actor: Actor = { id: input.createdBy }): Item {
		this.validateEntityInput(input);
		input = this.reasonInput(input);
		if (input.completion && input.state !== "done") throw new BacklogError("A completion requires state done.");
		refuseSecrets({ note: input.note });
		const title = storedTitle(input.title);
		if (!title) throw new BacklogError("An item needs a title.");
		// A person may jot a bare title; whatever an agent adds says how to tell it is done.
		if (input.createdBy !== USER_AUTHOR && !storedText(input.goal))
			throw new BacklogError("add needs a goal: the done criterion, a check someone else can run.");
		refuseSecrets({
			title: input.title,
			goal: input.goal,
			body: input.body,
			paths: input.paths,
			why: input.why,
			evidence: input.evidence,
			plan: input.plan,
			tags: input.tags,
		});
		const agentDb = this.agentDb();
		return agentDb.withActor(
			{ id: actor?.id ?? USER_AUTHOR, kind: actor?.kind ?? (actor?.id === USER_AUTHOR || !actor ? "human" : "agent") },
			() =>
				agentDb.transaction(() => {
					// Numbers are never reused, even after the newest item is deleted: the high-water mark lives in `meta`.
					const key = `backlog_seq:${this.repo}`;
					const mark = Number(readMeta(agentDb.db, key) ?? 0);
					const max =
						(
							agentDb.db.prepare("SELECT MAX(seq) AS n FROM backlog WHERE repo_key = ?").get(this.repo) as {
								n: number | null;
							}
						).n ?? 0;
					const seq = Math.max(mark, max) + 1;
					writeMeta(agentDb.db, key, String(seq));
					const from = input.from === undefined ? null : this.origin(input.from);
					const at = this.now();
					const wanted = input.state ?? "backlog";
					const state = wanted === "ongoing" || wanted === "done" ? "todo" : wanted;
					agentDb.db
						.prepare(
							`INSERT INTO backlog (repo_key, seq, title, goal, body, paths, why, evidence, plan, state, priority, tags, assignee, created_by, source_session, created_at, updated_at, started_at, done_at, from_item)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							this.repo,
							seq,
							title,
							storedText(input.goal),
							storedText(input.body),
							cleanList(input.paths ?? []).join("\n"),
							storedText(input.why),
							cleanList(input.evidence ?? []).join("\n"),
							storedText(input.plan),
							state,
							clampPriority(input.priority),
							cleanTags(input.tags ?? []).join(" "),
							input.createdBy,
							input.sourceSession ?? null,
							at,
							at,
							null,
							null,
							from,
						);
					const item = this.get(seq)!;
					this.applyEntities(item, input, actor, at);
					if (input.note?.trim()) this.log(item, at, actor.id, "note", storedText(input.note));
					if (item.from !== undefined)
						this.log(item, at, input.createdBy, "change", `created from ${refText(item.from)}`);
					return wanted === "ongoing" || wanted === "done"
						? this.update(item.ref, { state: wanted, completion: input.completion }, actor)
						: this.get(seq)!;
				}),
		);
	}

	/**
	 * Changes an item. `ongoing` claims it for `actor` (refused while another live assignee holds it); leaving
	 * `ongoing` for `backlog`/`todo` releases it; `done` stamps `done_at`. While another live session holds an item,
	 * others may only add a note (the user may force an edit). A subagent may only touch items its parent holds.
	 */
	update(ref: string, input: UpdateInput, actor: Actor): Item {
		this.validateEntityInput(input);
		input = this.reasonInput(input);
		refuseSecrets({
			title: input.title,
			goal: input.goal,
			body: input.body,
			paths: input.paths,
			why: input.why,
			evidence: input.evidence,
			plan: input.plan,
			note: input.note,
			tags: input.tags,
		});
		const agentDb = this.agentDb();
		return agentDb.withActor(
			{ id: actor?.id ?? USER_AUTHOR, kind: actor?.kind ?? (actor?.id === USER_AUTHOR || !actor ? "human" : "agent") },
			() =>
				agentDb.transaction(() => {
					const item = this.get(ref);
					if (!item) throw new BacklogError(`No backlog item ${ref}.`);
					if (input.completion) {
						const previous = item.completions.find((c) => c.operationKey === input.completion!.operationKey);
						if (previous) {
							const { id: _id, actor: _actor, at: _at, version: _version, goal: _goal, ...payload } = previous;
							if (!isDeepStrictEqual(payload, input.completion))
								throw new BacklogError("Completion operation key was already used with different content.");
							if (previous.actor !== actor.id || (actor.owners && !(item.assignee && actor.owners.has(item.assignee))))
								throw new BacklogError("Completion belongs to another actor.");
							return item;
						}
					}
					if (input.version !== undefined && input.version !== item.version)
						throw new BacklogError(`${item.ref} changed elsewhere — reload it.`, item);
					if (actor.owners && !(item.assignee && actor.owners.has(item.assignee))) {
						throw new BacklogError(
							`${item.ref} is not claimed by your parent: a subagent updates only the items its parent has claimed.`,
						);
					}
					const holder =
						!actor.owners && item.state === "ongoing" && item.assignee && item.assignee !== actor.id
							? this.liveHolder(item.assignee)
							: undefined;
					const changes = (
						[
							"title",
							"goal",
							"body",
							"paths",
							"why",
							"evidence",
							"plan",
							"state",
							"priority",
							"tags",
							"from",
							"type",
							"parentId",
							"dependsOn",
							"links",
							"completion",
						] as const
					).some((field) => input[field] !== undefined);
					if (holder && (input.state === "ongoing" || (changes && !input.force))) {
						throw new BacklogError(
							`${item.ref} is ongoing for ${holder}, which is still running: add a note, leave it, or ask the user.`,
						);
					}
					if (
						actor.owners &&
						[
							"title",
							"goal",
							"body",
							"paths",
							"why",
							"evidence",
							"plan",
							"priority",
							"tags",
							"from",
							"type",
							"parentId",
							"dependsOn",
							"links",
						].some((key) => input[key as keyof UpdateInput] !== undefined)
					)
						throw new BacklogError("A subagent changes only state, notes and completion of its parent's items.");
					if (actor.owners && (input.state === "todo" || input.state === "backlog"))
						throw new BacklogError("A subagent cannot release its parent's claim.");
					const state = input.state ?? item.state;
					if (!STATES.includes(state)) throw new BacklogError("Unknown backlog state.");
					if (
						(state === "ongoing" || state === "done") &&
						(input.state !== undefined ||
							input.completion !== undefined ||
							input.goal !== undefined ||
							input.why !== undefined)
					) {
						if (!(input.goal ?? item.goal).trim() || !(input.why ?? item.why).trim())
							throw new BacklogError("Starting or completing work needs a reason and goal.");
					}
					if (item.state === "done" && state !== "done" && !input.note?.trim())
						throw new BacklogError("Reopening needs a note explaining why.");
					if (item.state === "done" && state === "done" && (input.goal !== undefined || input.why !== undefined))
						throw new BacklogError("Reopen before changing a completed goal or reason.");
					if (state === "done" && item.state !== "done" && !input.completion)
						throw new BacklogError("Done needs a completion: summary, files, verification and operationKey.");
					if (input.completion && state !== "done") throw new BacklogError("A completion requires state done.");

					let assignee = item.assignee;
					if (input.state === "ongoing" && item.assignee !== actor.id) {
						if (!actor.owners) assignee = actor.id;
					} else if (input.state === "backlog" || input.state === "todo") assignee = undefined;
					const note = input.note === undefined ? "" : storedText(input.note);
					const at = this.now();
					const title = input.title === undefined ? item.title : storedTitle(input.title);
					if (!title) throw new BacklogError("An item needs a title.");
					const doneAt = state === "done" ? (item.state === "done" ? (item.doneAt ?? at) : at) : null;
					// A claim (or a takeover) starts the clock; releasing the item clears it; done keeps it, so the cycle time stays.
					const claimed = state === "ongoing" && (item.state !== "ongoing" || assignee !== item.assignee);
					const startedAt = claimed ? at : state === "backlog" || state === "todo" ? null : (item.startedAt ?? null);
					const fromItem =
						input.from === undefined
							? item.from === undefined
								? null
								: this.get(item.from)!.rowId
							: input.from === null
								? null
								: this.origin(input.from, item);
					agentDb.db
						.prepare(
							"UPDATE backlog SET title = ?, goal = ?, body = ?, paths = ?, why = ?, evidence = ?, plan = ?, state = ?, priority = ?, tags = ?, assignee = ?, updated_at = ?, started_at = ?, done_at = ?, from_item = ?, version = version + 1 WHERE id = ?",
						)
						.run(
							title,
							input.goal === undefined ? item.goal : storedText(input.goal),
							input.body === undefined ? item.body : storedText(input.body),
							(input.paths === undefined ? item.paths : cleanList(input.paths)).join("\n"),
							input.why === undefined ? item.why : storedText(input.why),
							(input.evidence === undefined ? item.evidence : cleanList(input.evidence)).join("\n"),
							input.plan === undefined ? item.plan : storedText(input.plan),
							state,
							input.priority === undefined ? item.priority : clampPriority(input.priority),
							input.tags === undefined ? item.tags.join(" ") : cleanTags(input.tags).join(" "),
							assignee ?? null,
							at,
							startedAt,
							doneAt,
							fromItem,
							item.rowId,
						);
					this.applyEntities(item, input, actor, at);
					const updated = this.get(item.seq)!;
					// What changed first, then why: notes at one time read in insertion order.
					const change = [
						changeText(item, updated),
						...(["type", "parentId", "dependsOn", "links"] as const)
							.filter((key) => JSON.stringify(item[key]) !== JSON.stringify(updated[key]))
							.map((key) => `${key}: ${JSON.stringify(item[key] ?? null)} → ${JSON.stringify(updated[key] ?? null)}`),
						...(input.completion ? ["completion recorded"] : []),
					]
						.filter(Boolean)
						.join(" · ");
					if (change) this.log(item, at, actor.id, "change", change);
					if (note) this.log(item, at, actor.id, "note", note);
					return updated;
				}),
		);
	}

	private log(item: Item, at: number, author: string, kind: NoteKind, text: string): void {
		this.db
			.prepare("INSERT INTO backlog_notes (item, at, author, kind, text) VALUES (?, ?, ?, ?, ?)")
			.run(item.rowId, at, author, kind, text);
	}

	/** Deletes an item and its notes. With `actor` (the agent), an item another live session holds is refused. */
	remove(ref: string, version?: number, actor?: Actor): Item {
		const agentDb = this.agentDb();
		return agentDb.withActor(
			{ id: actor?.id ?? USER_AUTHOR, kind: actor?.kind ?? (actor?.id === USER_AUTHOR || !actor ? "human" : "agent") },
			() =>
				agentDb.transaction(() => {
					const item = this.get(ref);
					if (!item) throw new BacklogError(`No backlog item ${ref}.`);
					if (version !== undefined && version !== item.version)
						throw new BacklogError(`${item.ref} changed elsewhere — reload it.`, item);
					const holder =
						actor && item.state === "ongoing" && item.assignee && item.assignee !== actor.id
							? this.liveHolder(item.assignee)
							: undefined;
					if (holder)
						throw new BacklogError(
							`${item.ref} is ongoing for ${holder}, which is still running: leave it or ask the user.`,
						);
					if (
						this.list().items.some(
							(other) => other.parentId === item.ref || other.dependsOn.some((r) => r.id === item.ref),
						)
					)
						throw new BacklogError("Reparent children and remove dependencies before deleting this item.");
					if (item.completions.length) throw new BacklogError("Items with completion history cannot be deleted.");
					// The items that came from it keep a trace of the link in their change log.
					const at = this.now();
					for (const child of this.derived(item)) {
						agentDb.db
							.prepare("UPDATE backlog SET from_item = NULL, updated_at = ?, version = version + 1 WHERE id = ?")
							.run(at, child.rowId);
						this.log(
							child,
							at,
							actor?.id ?? USER_AUTHOR,
							"change",
							`from ${item.ref} → none (${item.ref} "${item.title}" was removed)`,
						);
					}
					agentDb.db.prepare("DELETE FROM backlog WHERE id = ?").run(item.rowId);
					return item;
				}),
		);
	}

	private reasonInput<T extends { reason?: string; why?: string }>(input: T): T {
		if (input.reason !== undefined && input.why !== undefined && input.reason !== input.why)
			throw new BacklogError("reason and why must agree.");
		return input.reason === undefined ? input : { ...input, why: input.reason };
	}

	private validateEntityInput(input: EntityInput): void {
		if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 1))
			throw new BacklogError("Invalid item version.");
		if (!Value.Check(EntityFieldsSchema, input)) {
			const first = Value.Errors(EntityFieldsSchema, input)[0];
			throw new BacklogError(
				`Invalid backlog entity fields${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}.`,
			);
		}
		if (input.completion && !input.completion.operationKey.trim())
			throw new BacklogError("Completion needs an operationKey.");
		refuseSecrets({
			reason: input.reason,
			links: input.links === undefined ? undefined : JSON.stringify(input.links),
			completion: input.completion === undefined ? undefined : JSON.stringify(input.completion),
		});
		for (const link of input.links ?? []) {
			if (link.target.resource === "external") {
				const url = new URL(link.target.url);
				if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
					throw new BacklogError("External links need an HTTP(S) URL without credentials.");
			}
		}
		for (const file of [
			...(input.completion?.files ?? []),
			...(input.links ?? []).flatMap((l) => (l.target.resource === "files" ? [l.target] : [])),
		]) {
			if (/^(?:[\\/]|[a-z]:)/i.test(file.path) || file.path.split(/[\\/]/).includes("..") || !file.path.trim())
				throw new BacklogError("Files need repository-relative paths without traversal.");
		}
	}

	private enrich(base: ReturnType<typeof toItem<State>>): Item {
		const row = this.db.prepare("SELECT type, parent_id FROM backlog WHERE id = ?").get(base.rowId) as {
			type: ItemType;
			parent_id: number | null;
		};
		const parent =
			row.parent_id === null
				? undefined
				: (this.db.prepare("SELECT seq FROM backlog WHERE id = ? AND repo_key = ?").get(row.parent_id, this.repo) as
						| { seq: number }
						| undefined);
		const rows = this.db
			.prepare("SELECT relation, target FROM backlog_links WHERE item = ? ORDER BY rowid")
			.all(base.rowId) as { relation: string; target: string }[];
		return {
			...base,
			reason: base.why,
			type: row.type,
			...(parent ? { parentId: refText(parent.seq) } : {}),
			dependsOn: rows.filter((r) => r.relation === "depends_on").map((r) => JSON.parse(r.target) as BacklogRef),
			links: rows
				.filter((r) => r.relation !== "depends_on")
				.map((r) => ({ relation: r.relation, target: JSON.parse(r.target) }) as WorkLink),
			completions: (
				this.db.prepare("SELECT id, payload FROM backlog_completions WHERE item = ? ORDER BY id").all(base.rowId) as {
					id: number;
					payload: string;
				}[]
			).map((r) => ({ ...JSON.parse(r.payload), id: r.id })),
		};
	}

	private applyEntities(before: Item, input: EntityInput & { state?: State }, actor: Actor, at: number): void {
		if (input.parentId !== undefined && input.parentId !== (before.parentId ?? null)) {
			const parent = input.parentId === null ? undefined : this.get(input.parentId);
			if (input.parentId !== null && !parent) throw new BacklogError("Parent does not exist in this repository.");
			if (parent?.state === "done") throw new BacklogError("Reopen the parent before adding children.");
			this.db.prepare("UPDATE backlog SET parent_id = ? WHERE id = ?").run(parent?.rowId ?? null, before.rowId);
		}
		if (input.type !== undefined)
			this.db.prepare("UPDATE backlog SET type = ? WHERE id = ?").run(input.type, before.rowId);
		if (input.dependsOn !== undefined) {
			const refs = input.dependsOn.map((value): BacklogRef => {
				const ref =
					typeof value === "string" ? { resource: "backlogs" as const, repositoryKey: this.repo, id: value } : value;
				const target = ref.repositoryKey === this.repo ? this.get(ref.id) : undefined;
				if (!target) throw new BacklogError("Dependencies must exist in the same repository.");
				return { resource: "backlogs", repositoryKey: this.repo, id: target.ref };
			});
			this.db.prepare("DELETE FROM backlog_links WHERE item = ? AND relation = 'depends_on'").run(before.rowId);
			for (const ref of refs)
				this.db
					.prepare("INSERT OR IGNORE INTO backlog_links VALUES (?, 'depends_on', ?)")
					.run(before.rowId, JSON.stringify(ref));
		}
		if (input.links !== undefined) {
			this.db.prepare("DELETE FROM backlog_links WHERE item = ? AND relation != 'depends_on'").run(before.rowId);
			for (const link of input.links)
				this.db
					.prepare("INSERT OR IGNORE INTO backlog_links VALUES (?, ?, ?)")
					.run(before.rowId, link.relation, JSON.stringify(link.target));
		}
		const items = this.list().items;
		const current = items.find((i) => i.rowId === before.rowId)!;
		const byRef = new Map(items.map((i) => [i.ref, i]));
		const edges = new Map(
			items.map((i) => [
				i.ref,
				[
					...i.dependsOn.map((r) => r.id),
					...items.filter((child) => child.parentId === i.ref).map((child) => child.ref),
				],
			]),
		);
		const active = new Set<string>();
		const visited = new Set<string>();
		const visit = (ref: string): void => {
			if (active.has(ref)) throw new BacklogError("Hierarchy and dependencies would create a waiting cycle.");
			if (visited.has(ref)) return;
			active.add(ref);
			for (const next of edges.get(ref) ?? []) visit(next);
			active.delete(ref);
			visited.add(ref);
		};
		for (const item of items) visit(item.ref);
		const unresolved = current.dependsOn.filter((r) => byRef.get(r.id)?.state !== "done");
		const closing = current.state === "done" && (before.state !== "done" || input.completion !== undefined);
		const starting = input.state === "ongoing" && (before.state !== "ongoing" || before.assignee !== current.assignee);
		const addedPrerequisite = unresolved.some(
			(ref) => !before.dependsOn.some((old) => old.id === ref.id && old.repositoryKey === ref.repositoryKey),
		);
		if (["ongoing", "done"].includes(current.state) && unresolved.length && (closing || starting || addedPrerequisite))
			throw new BacklogError(`Blocked by ${unresolved.map((r) => r.id).join(", ")}.`);

		const descendants = (parent: string): Item[] =>
			items.filter((i) => i.parentId === parent).flatMap((child) => [child, ...descendants(child.ref)]);
		if (closing && descendants(current.ref).some((i) => i.state !== "done"))
			throw new BacklogError("Finish child items before completing their parent.");
		if (input.completion && current.state === "done") {
			const c = input.completion;
			if (!c.summary.trim() || !c.verification.summary.trim())
				throw new BacklogError("Completion needs a summary and verification explanation.");
			if (actor.kind !== "human" && !["passed", "not_applicable"].includes(c.verification.status))
				throw new BacklogError("Agents must verify the goal before completing it.");
			if (before.state === "done" && c.replaces !== before.completions.at(-1)?.id)
				throw new BacklogError("A correction must replace the latest completion.");
			if (c.replaces !== undefined && !before.completions.some((old) => old.id === c.replaces))
				throw new BacklogError("Completion to replace does not exist.");
			this.db
				.prepare("INSERT INTO backlog_completions (item, operation_key, payload) VALUES (?, ?, ?)")
				.run(
					before.rowId,
					c.operationKey,
					JSON.stringify({ ...c, actor: actor.id, at, version: current.version, goal: current.goal }),
				);
		}
	}

	/** `assignee` when it is a session whose process still runs, else undefined (a finished session's claim can be taken over). */
	liveHolder(assignee: string): string | undefined {
		const pid = sessionRunningPid(this.db, assignee);
		return pid !== undefined && pid !== process.pid ? assignee : undefined;
	}
}

function clampPriority(priority: number | undefined): number {
	return priority === undefined || !Number.isInteger(priority) ? 2 : Math.min(3, Math.max(0, priority));
}
