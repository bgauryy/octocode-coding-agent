import type { AgentDb } from "../agentdb/db.ts";
import { memories, meta } from "../agentdb/api.ts";
import type { MemoryFilter, MemoryScope, ScopeFilter } from "../agentdb/queries/memories.ts";
export type { MemoryFilter, ScopeFilter };
import type { Row } from "../agentdb/rows.ts";
import { storedSecret, storedText } from "../shared/sanitize.ts";
import { clipText, stringOrEmpty } from "../shared/util.ts";
import { ftsQuery, jaccard, MAX_QUERY_TERMS, memoryLabel, normalizeTitle, stem, terms } from "./query.ts";

export const MEMORY_KINDS = ["preference", "fact", "decision", "gotcha", "procedure"] as const;
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

/** The refusal for an id that is no memory here: a missing one, or a project memory of another repository (or hidden in an untrusted project). */
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
/** Token overlap (title + body) at which a new memory counts as a duplicate of an existing one. */
const DUPLICATE_JACCARD = 0.6;
/** Rows the LIKE fallback scores in memory (newest first); far more than a person keeps. */
const LIKE_SCAN_LIMIT = 2000;
const SETTING_AUTO = "memory_auto";

function toMemory(row: Row): Memory {
	return {
		id: Number(row.id),
		scope: row.scope === "global" ? "global" : "project",
		repoKey: (row.repo_key as string | null) ?? null,
		kind: (MEMORY_KINDS as readonly string[]).includes(String(row.kind)) ? (row.kind as MemoryKind) : "fact",
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
	constructor(agentDb: AgentDb, repoKey: string) {
		this.agentDb = agentDb;
		this.repoKey = repoKey;
	}

	private get db() {
		return this.agentDb.db;
	}

	/** A memory visible from this repository (global, or project of this repo), else undefined. */
	get(id: number): Memory | undefined {
		const row = memories.visible(this.db, this.repoKey, id);
		return row ? toMemory(row) : undefined;
	}

	/** Pinned first, then most recently updated. */
	list(scope: ScopeFilter = "all", limit = 50, options: MemoryFilter = {}): Memory[] {
		return memories.list(this.db, this.repoKey, scope, limit, options).map(toMemory);
	}

	/** The `updatedAt` of each of `ids` that still exists, in one query. */
	updatedAt(ids: readonly number[]): Map<number, number> {
		if (ids.length === 0) return new Map();
		return memories.updatedAt(this.db, ids);
	}

	count(scope: ScopeFilter = "all", options: MemoryFilter = {}): number {
		return memories.count(this.db, this.repoKey, scope, options);
	}

	/**
	 * Best matches for the words of `query`, best first. With FTS5: BM25 over title, keywords and body (weighted 5/3/1).
	 * Without it: the same column weights times each term's inverse document frequency. Project hits get a small boost either way.
	 */
	search(query: string, scope: ScopeFilter = "all", limit = 10, exclude: ReadonlySet<number> = new Set()): MemoryHit[] {
		const match = ftsQuery(query);
		if (!match) return [];
		const hits = this.agentDb.fts
			? this.searchFts(match, scope, limit * 3, exclude)
			: this.searchLike([...new Set(terms(query, MAX_QUERY_TERMS).map(stem))], scope);
		return hits
			.filter((hit) => !exclude.has(hit.id))
			.map((hit) => (hit.scope === "project" ? { ...hit, score: hit.score * PROJECT_BOOST } : hit))
			.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
			.slice(0, limit);
	}

	private searchFts(match: string, scope: ScopeFilter, limit: number, exclude: ReadonlySet<number>): MemoryHit[] {
		const rows = memories.searchFts(this.db, this.repoKey, match, scope, exclude, limit);
		// bm25() is lower-is-better and negative for matches; negate so every score reads higher-is-better.
		return rows.map((row) => ({ ...toMemory(row), score: -Number(row.bm25_score) }));
	}

	/** BM25-like without FTS5: per-column weights (5/3/1) times each term's inverse document frequency; `words` are stems. */
	private searchLike(words: string[], scope: ScopeFilter): MemoryHit[] {
		const docs = memories.newest(this.db, this.repoKey, scope, LIKE_SCAN_LIMIT).map((row) => {
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
	 * the same scope (same title, or most of the same words), naming it so the caller can update it instead.
	 */
	set(
		input: MemoryInput & { id?: number; author: string; sourceSession?: string; hideProject?: boolean },
		now = Date.now(),
	): { memory: Memory; created: boolean } {
		refuseMemorySecrets(input);
		return this.agentDb.transaction(() =>
			input.id === undefined ? this.insert(input, now) : this.update(input.id, input, now),
		);
	}

	private insert(
		input: MemoryInput & { author: string; sourceSession?: string; hideProject?: boolean },
		now: number,
	): { memory: Memory; created: boolean } {
		const title = storedText(input.title);
		if (!title) throw new MemoryError("A new memory needs a title.");
		const body = storedText(input.body);
		const scope = input.scope ?? "project";
		const duplicate = this.duplicateOf(scope, title, body);
		// An untrusted project cannot read project memories: name the duplicate without showing it.
		if (duplicate && input.hideProject && duplicate.scope === "project") {
			throw new MemoryError(
				`A similar project memory (${memoryLabel(duplicate.id)}) exists, hidden in this untrusted project. Change the title, or ask the user to /trust the project.`,
			);
		}
		if (duplicate)
			throw new MemoryError(
				`Similar memory ${memoryLabel(duplicate.id)} exists: "${duplicate.title}". Call set with id:"${memoryLabel(duplicate.id)}" to update it, or change the title.`,
			);
		const id = memories.insert(this.db, {
			scope,
			repoKey: scope === "project" ? this.repoKey : null,
			kind: input.kind ?? "fact",
			title,
			body,
			keywords: storedText(input.keywords),
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
		memories.update(this.db, id, {
			scope,
			repoKey: scope === "project" ? (current.scope === "project" ? current.repoKey : this.repoKey) : null,
			kind: input.kind ?? current.kind,
			title,
			body: input.body === undefined ? current.body : storedText(input.body),
			keywords: input.keywords === undefined ? current.keywords : storedText(input.keywords),
			pinned: input.pinned ?? current.pinned,
			author: input.author,
			now,
		});
		return { memory: this.get(id)!, created: false };
	}

	/** An existing memory in `scope` with the same normalized title, or whose title+body words mostly match. */
	private duplicateOf(scope: MemoryScope, title: string, body: string): Memory | undefined {
		const normalized = normalizeTitle(title);
		const words = terms(`${title} ${body}`);
		const candidates = [...this.search(`${title} ${body}`, scope, 5), ...this.list(scope, 200)];
		return candidates.find(
			(memory) =>
				(normalized !== "" && normalizeTitle(memory.title) === normalized) ||
				jaccard(words, terms(`${memory.title} ${memory.body}`)) >= DUPLICATE_JACCARD,
		);
	}

	delete(id: number): Memory {
		const current = this.get(id);
		if (!current) throw noMemory(id);
		memories.remove(this.db, id);
		return current;
	}

	/** Records that `ids` were handed to the model. */
	markUsed(ids: readonly number[], now = Date.now()): void {
		if (ids.length === 0) return;
		this.agentDb.transaction(() => memories.markUsed(this.db, ids, now));
	}

	/** `/memory auto on|off`, shared by every session (the environment can still turn it off). */
	autoSetting(): boolean {
		return meta.read(this.db, SETTING_AUTO) !== "off";
	}

	setAutoSetting(on: boolean): void {
		meta.write(this.db, SETTING_AUTO, on ? "on" : "off");
	}
}

/** `project, decision, pinned`: where a memory lives, what it is, and whether it is pinned. */
export const memoryTags = (memory: Memory): string =>
	[memory.scope, memory.kind, ...(memory.pinned ? ["pinned"] : [])].join(", ");

/** The call that reads memory `id` whole: where every model-facing line with a cut body ends. */
export const memoryGetCall = (id: number): string => `memory get ${memoryLabel(id)}`;

/** `M3 (project, decision, pinned) Title — body`, one line; the body whole unless `bodyChars` clips it (a one-line view for a person). */
export function memoryLine(memory: Memory, bodyChars = Number.POSITIVE_INFINITY): string {
	const body = memory.body.replace(/\s+/g, " ").trim();
	const clipped = clipText(body, bodyChars);
	return `${memoryLabel(memory.id)} (${memoryTags(memory)}) ${memory.title.replace(/\s+/g, " ")}${clipped ? ` — ${clipped}` : ""}`;
}

/** `memoryLine` for the model: a body clipped to `bodyChars` ends the line with the call that reads it whole. */
export function memoryToolLine(memory: Memory, bodyChars: number): string {
	const cut = memory.body.replace(/\s+/g, " ").trim().length > bodyChars;
	return `${memoryLine(memory, bodyChars)}${cut ? ` (${memoryGetCall(memory.id)})` : ""}`;
}
