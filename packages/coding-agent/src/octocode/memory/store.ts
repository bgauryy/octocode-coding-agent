import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { repoKey } from "../../utils/git-repository.ts";
import {
	type AgentDb,
	type DbWriter,
	type MemoryFilter,
	type MemoryScope,
	memories,
	meta,
	type Row,
	type ScopeFilter,
} from "../../../../db/src/api.ts";
import { agentDbWriter, sharedAgentDb, sharedAgentDbWriter } from "../../storage/database.ts";
export type { MemoryFilter, ScopeFilter };
import { storedSecret, storedText } from "../../../../common/src/sanitize.ts";
import { clipText, DAY_MS, stringOrEmpty } from "../shared/util.ts";
import { ftsQuery, jaccard, MAX_QUERY_TERMS, memoryLabel, normalizeTitle, stem, terms } from "./query.ts";

/** `reference`: a pointer to something outside the repository (a URL, dashboard or ticket). */
export const MEMORY_KINDS = ["preference", "fact", "decision", "gotcha", "procedure", "reference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export interface Memory {
	id: number;
	scope: MemoryScope;
	repoKey: string | null;
	kind: MemoryKind;
	title: string;
	body: string;
	keywords: string;
	pinned: boolean;
	author: string;
	sourceSession: string | null;
	createdAt: number;
	updatedAt: number;
	lastUsed: number | null;
	useCount: number;
}

/** A search hit: `score` is higher-is-better (negated BM25, or the LIKE fallback's IDF-weighted column match). */
interface MemoryHit extends Memory {
	score: number;
}

export interface MemoryInput {
	scope?: MemoryScope;
	kind?: MemoryKind;
	title?: string;
	body?: string;
	keywords?: string;
	pinned?: boolean;
}

/** A refused write: a secret, a near-duplicate, or a missing/unknown memory. */
export class MemoryError extends Error {}

/** The refusal for an id that is no memory here: a missing one, or a project memory of another repository. Trust never hides a memory. */
export const noMemory = (id: number): MemoryError =>
	new MemoryError(`No memory ${memoryLabel(id)} here (it may belong to another repository).`);

/** Refuses title, body or keywords that look like a secret. Checked on the sanitized text, the form that is stored: an invisible character must not split a token past it. */
export function refuseMemorySecrets(input: Pick<MemoryInput, "title" | "body" | "keywords">): void {
	const found = storedSecret({ title: input.title, body: input.body, keywords: input.keywords });
	if (found)
		throw new MemoryError(`Refused: this looks like a secret (${found.problem}). Never store credentials in memory.`);
}

/** A project hit ranks this much above an equally good global one. */
const PROJECT_BOOST = 1.15;
/** Token overlap (title + keywords + body) at which a new memory counts as a duplicate of an existing one. */
const DUPLICATE_JACCARD = 0.6;
/** Rows the LIKE fallback scores in memory (newest first); far more than a person keeps. */
const LIKE_SCAN_LIMIT = 2000;
const SETTING_AUTO = "memory_auto";

function toMemory(row: Row): Memory {
	return {
		id: Number(row.id),
		scope: row.scope as MemoryScope,
		repoKey: (row.repo_key as string | null) ?? null,
		kind: row.kind as MemoryKind,
		title: stringOrEmpty(row.title),
		body: stringOrEmpty(row.body),
		keywords: stringOrEmpty(row.keywords),
		pinned: Number(row.pinned) === 1,
		author: stringOrEmpty(row.author),
		sourceSession: (row.source_session as string | null) ?? null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		lastUsed: row.last_used == null ? null : Number(row.last_used),
		useCount: Number(row.use_count ?? 0),
	};
}

/**
 * Memories of one repository (`repoKey`) plus the global ones, in the shared agent DB. Every method is one statement or
 * one transaction; the DB's WAL mode lets sessions read and write side by side.
 */
export class MemoryStore {
	private readonly agentDb: AgentDb;
	readonly repoKey: string;
	readonly workspaceId: string | undefined;
	/** The writer of the same database file (`sharedAgentDbWriter`): bookkeeping writes go there, off this thread. */
	private readonly writer: () => DbWriter;
	constructor(agentDb: AgentDb, repoKey: string, workspaceId?: string, writer?: () => DbWriter) {
		this.agentDb = agentDb;
		this.repoKey = repoKey;
		this.workspaceId = workspaceId;
		this.writer = writer ?? (() => agentDbWriter(agentDb));
	}

	private get context(): memories.MemoryContext {
		return { repoKey: this.repoKey, workspaceId: this.workspaceId };
	}
	private storageScope(scope: MemoryScope) {
		if (scope === "workspace" && !this.workspaceId) throw new MemoryError("No workspace is bound.");
		return {
			scope,
			repoKey: scope === "project" ? this.repoKey : null,
			workspaceId: scope === "workspace" ? this.workspaceId! : null,
		};
	}
	private get db() {
		return this.agentDb.db;
	}

	/** A memory visible from this repository (global, or project of this repo), else undefined. */
	get(id: number): Memory | undefined {
		const row = memories.visible(this.db, this.context, id);
		return row ? toMemory(row) : undefined;
	}

	/** Pinned first, then most recently updated. */
	list(scope: ScopeFilter = "all", limit = 50, options: MemoryFilter = {}): Memory[] {
		return memories.list(this.db, this.context, scope, limit, options).map(toMemory);
	}

	/** Bounded retrieval for the `memory` tool; the cursor visits every visible note. */
	scan(scope: ScopeFilter, before: memories.MemoryCursor, limit: number): Memory[] {
		return memories.scan(this.db, this.context, scope, before, limit).map(toMemory);
	}

	/** The `updatedAt` of each of `ids` that still exists, in one query. */
	updatedAt(ids: readonly number[]): Map<number, number> {
		if (ids.length === 0) return new Map();
		return memories.updatedAt(this.db, this.context, ids);
	}

	count(scope: ScopeFilter = "all", options: MemoryFilter = {}): number {
		return memories.count(this.db, this.context, scope, options);
	}

	/** Memories never handed to the model, or not updated in `days` days, oldest update first (`/memory review`). */
	review(days: number, scope: ScopeFilter = "all", limit = 100, now = Date.now()): Memory[] {
		return memories.forReview(this.db, this.context, scope, now - days * DAY_MS, limit).map(toMemory);
	}

	/**
	 * Best matches for the words of `query`, best first. With FTS5: BM25 over title, keywords and body (weighted 5/3/1).
	 * Without it: the same column weights times each term's inverse document frequency. Project hits get a small boost either way.
	 */
	search(
		query: string,
		scope: ScopeFilter = "all",
		limit = 10,
		exclude: ReadonlySet<number> = new Set(),
		now = Date.now(),
	): MemoryHit[] {
		const match = ftsQuery(query);
		if (!match) return [];
		const hits = this.agentDb.fts
			? this.searchFts(match, scope, limit * 3, exclude)
			: this.searchLike([...new Set(terms(query, MAX_QUERY_TERMS).map(stem))], scope);
		return hits
			.filter((hit) => !exclude.has(hit.id))
			.map((hit) => (hit.scope !== "global" ? { ...hit, score: hit.score * PROJECT_BOOST } : hit))
			.map((hit) => (unusedForLong(hit, now) ? { ...hit, score: hit.score * UNUSED_DISCOUNT } : hit))
			.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
			.slice(0, limit);
	}

	/** The `memory` tool pages ranked matches from the existing full-text index; absent FTS uses its bounded scan. */
	searchPage(query: string, scope: ScopeFilter, offset: number, limit: number): MemoryHit[] | undefined {
		if (!this.agentDb.fts) return undefined;
		const match = ftsQuery(query);
		if (!match) return [];
		return memories
			.searchFts(this.db, this.context, match, scope, new Set(), limit, offset)
			.map((row) => ({ ...toMemory(row), score: -Number(row.bm25_score) }));
	}

	private searchFts(match: string, scope: ScopeFilter, limit: number, exclude: ReadonlySet<number>): MemoryHit[] {
		const rows = memories.searchFts(this.db, this.context, match, scope, exclude, limit);
		// bm25() is lower-is-better and negative for matches; negate so every score reads higher-is-better.
		return rows.map((row) => ({ ...toMemory(row), score: -Number(row.bm25_score) }));
	}

	/** BM25-like without FTS5: per-column weights (5/3/1) times each term's inverse document frequency; `words` are stems. */
	private searchLike(words: string[], scope: ScopeFilter): MemoryHit[] {
		const docs = memories.newest(this.db, this.context, scope, LIKE_SCAN_LIMIT).map((row) => {
			const memory = toMemory(row);
			const stems = (text: string) => new Set(terms(text).map(stem));
			return { memory, title: stems(memory.title), keywords: stems(memory.keywords), body: stems(memory.body) };
		});
		const idf = new Map(
			words.map((word) => {
				const df = docs.filter((doc) => doc.title.has(word) || doc.keywords.has(word) || doc.body.has(word)).length;
				return [word, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
			}),
		);
		return docs.flatMap((doc) => {
			const score = words.reduce(
				(sum, word) =>
					sum +
					idf.get(word)! *
						((doc.title.has(word) ? 5 : 0) + (doc.keywords.has(word) ? 3 : 0) + (doc.body.has(word) ? 1 : 0)),
				0,
			);
			return score > 0 ? [{ ...doc.memory, score }] : [];
		});
	}

	/**
	 * Adds a memory, or updates memory `id`. Refuses text that looks like a secret, and a new memory that repeats one in
	 * the same scope (same title, or most of the same words), naming it so the caller can update it instead. An update
	 * that moves a memory to another scope is checked the same way against that scope.
	 */
	set(
		input: MemoryInput & { id?: number; author: string; sourceSession?: string },
		now = Date.now(),
	): { memory: Memory; created: boolean } {
		refuseMemorySecrets(input);
		return this.agentDb.transaction(() =>
			input.id === undefined ? this.insert(input, now) : this.update(input.id, input, now),
		);
	}

	private insert(
		input: MemoryInput & { author: string; sourceSession?: string },
		now: number,
	): { memory: Memory; created: boolean } {
		const title = storedText(input.title);
		if (!title) throw new MemoryError("A new memory needs a title.");
		const body = storedText(input.body);
		const scope = input.scope ?? (this.workspaceId ? "workspace" : "project");
		const keywords = storedText(input.keywords);
		const duplicate = this.duplicateOf(scope, `${title} ${keywords} ${body}`, title);
		if (duplicate)
			throw new MemoryError(
				`Similar memory ${memoryLabel(duplicate.id)} exists: "${duplicate.title}". Call set with id:"${memoryLabel(duplicate.id)}" to update it, or change the title.`,
			);
		const id = memories.insert(this.db, {
			...this.storageScope(scope),
			kind: input.kind ?? "fact",
			title,
			body,
			keywords,
			pinned: input.pinned ?? false,
			author: input.author,
			sourceSession: input.sourceSession ?? null,
			now,
		});
		return { memory: this.get(id)!, created: true };
	}

	/** An edit makes `input.author` the author: an agent edit of a user's memory must not keep the user tag. */
	private update(
		id: number,
		input: MemoryInput & { author: string },
		now: number,
	): { memory: Memory; created: boolean } {
		const current = this.get(id);
		if (!current) throw noMemory(id);
		const title = input.title === undefined ? current.title : storedText(input.title);
		if (!title) throw new MemoryError("A memory needs a title.");
		const scope = input.scope ?? current.scope;
		const body = input.body === undefined ? current.body : storedText(input.body);
		const keywords = input.keywords === undefined ? current.keywords : storedText(input.keywords);
		// Moving to another scope is an insert there: refuse it when it repeats a memory already in that scope.
		if (scope !== current.scope) {
			const duplicate = this.duplicateOf(scope, `${title} ${keywords} ${body}`, title);
			if (duplicate && duplicate.id !== id)
				throw new MemoryError(
					`Similar memory ${memoryLabel(duplicate.id)} exists in ${scope} scope: "${duplicate.title}". Update or delete one of them instead.`,
				);
		}
		memories.update(this.db, id, {
			...this.storageScope(scope),
			kind: input.kind ?? current.kind,
			title,
			body,
			keywords,
			pinned: input.pinned ?? current.pinned,
			author: input.author,
			// Recall uses updatedAt as a revision: equal or backward clocks must not hide an edit.
			now: Math.max(now, current.updatedAt + 1),
		});
		return { memory: this.get(id)!, created: false };
	}

	/** An existing memory in `scope` with the same normalized title, or whose title, keyword and body words (`text`) mostly match. */
	private duplicateOf(scope: MemoryScope, text: string, title: string): Memory | undefined {
		const normalized = normalizeTitle(title);
		const words = terms(text);
		const candidates = [...this.search(text, scope, 5), ...this.list(scope, 200)];
		return candidates.find(
			(memory) =>
				(normalized !== "" && normalizeTitle(memory.title) === normalized) ||
				jaccard(words, terms(`${memory.title} ${memory.keywords} ${memory.body}`)) >= DUPLICATE_JACCARD,
		);
	}

	delete(id: number): Memory {
		return this.agentDb.transaction(() => {
			const current = this.get(id);
			if (!current) throw noMemory(id);
			memories.remove(this.db, id);
			return current;
		});
	}

	/** Records that `ids` were handed to the model. */
	markUsed(ids: readonly number[], now = Date.now()): void {
		if (ids.length === 0) return;
		this.agentDb.transaction(() => memories.markUsed(this.db, this.context, ids, now));
	}

	/** `markUsed` through the database writer: this thread never waits for another process's write lock. */
	async markUsedLater(ids: readonly number[], now = Date.now()): Promise<void> {
		if (ids.length === 0) return;
		await this.writer().post({ kind: "memory-used", context: this.context, ids: [...ids], now });
	}

	/** `/memory auto on|off`, shared by every session (the environment can still turn it off). */
	autoSetting(): boolean {
		return meta.read(this.db, SETTING_AUTO) !== "off";
	}

	setAutoSetting(on: boolean): void {
		meta.write(this.db, SETTING_AUTO, on ? "on" : "off");
	}
}

/** A memory nobody used for this long ranks lower in a search; nothing expires, and a pinned one stays where it is. */
const UNUSED_DAYS = 90;
const UNUSED_DISCOUNT = 0.75;
const unusedForLong = (memory: Memory, now: number): boolean =>
	!memory.pinned && now - (memory.lastUsed ?? memory.updatedAt) > UNUSED_DAYS * DAY_MS;

/** `12d`: whole days since the memory was last updated, the staleness signal on every line the model reads. */
export const memoryAge = (memory: Pick<Memory, "updatedAt">, now = Date.now()): string =>
	`${Math.max(0, Math.floor((now - memory.updatedAt) / DAY_MS))}d`;

/** `project, decision, pinned`: where a memory lives, what it is, whether it is pinned, and with `now` its age (`12d`). */
export const memoryTags = (memory: Memory, now?: number): string =>
	[
		memory.scope,
		memory.kind,
		...(memory.pinned ? ["pinned"] : []),
		...(now === undefined ? [] : [memoryAge(memory, now)]),
	].join(", ");

/** The call that reads memory `id` whole: where every model-facing line with a cut body ends. */
export const memoryGetCall = (id: number): string => `memory op=get id=${memoryLabel(id)}`;

/**
 * `M3 (project, decision, pinned) Title — body`, one line; the body whole unless `bodyChars` clips it (a one-line view for
 * a person). With `now` the tags end with the memory's age.
 */
export function memoryLine(memory: Memory, bodyChars = Number.POSITIVE_INFINITY, now?: number): string {
	const body = memory.body.replace(/\s+/g, " ").trim();
	const clipped = clipText(body, bodyChars);
	return `${memoryLabel(memory.id)} (${memoryTags(memory, now)}) ${memory.title.replace(/\s+/g, " ")}${clipped ? ` — ${clipped}` : ""}`;
}

/** `memoryLine` for the model, with the age: a body clipped to `bodyChars` ends the line with the call that reads it whole. */
export function memoryToolLine(memory: Memory, bodyChars: number, now = Date.now()): string {
	const cut = memory.body.replace(/\s+/g, " ").trim().length > bodyChars;
	return `${memoryLine(memory, bodyChars, now)}${cut ? ` (${memoryGetCall(memory.id)})` : ""}`;
}

/** The memory store of `cwd`'s repository in the shared agent DB (the DB reopens when its path changes). */
export function memoryStore(cwd: string, env: NodeJS.ProcessEnv = process.env): MemoryStore {
	const db = sharedAgentDb(env);
	const workspace = registeredWorkspace(cwd, db);
	return new MemoryStore(db, repoKey(workspace.root).key, workspace.id, () => sharedAgentDbWriter(env));
}

/** The full view of one memory, for `get`. */
export function describeMemory(memory: Memory, now = Date.now()): string {
	const days = (at: number) => `${Math.max(0, Math.round((now - at) / DAY_MS))}d ago`;
	return [
		memoryLine(memory, 0),
		...(memory.keywords ? [`keywords: ${memory.keywords}`] : []),
		`author: ${memory.author} · updated ${days(memory.updatedAt)} · used ${memory.useCount}×${memory.lastUsed ? ` (last ${days(memory.lastUsed)})` : ""}`,
		"",
		memory.body || "(no body)",
	].join("\n");
}
