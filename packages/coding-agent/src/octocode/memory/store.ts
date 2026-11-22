import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { repoKey } from "../../utils/git-repository.ts";
import {
	type AgentDb,
	type DbWriter,
	type MemoryFilter,
	type MemoryScope,
	memories,
	type ScopeFilter,
} from "../../../../db/src/api.ts";
import { agentDbWriter, sharedAgentDb, sharedAgentDbWriter } from "../../storage/database.ts";
export type { MemoryFilter, ScopeFilter };
import { storedText } from "@octocodeai/octocode-common/sanitize";
import { clipText, DAY_MS } from "../shared/util.ts";
import { jaccard, memoryLabel, normalizeTitle, terms } from "./query.ts";
import { checkRevision, MemoryError, noMemory } from "./errors.ts";
import { isCandidate } from "./file/candidate-tags.ts";
import { type Memory, type MemoryHit, type MemoryInput, refuseMemorySecrets, toMemory } from "./record.ts";
import { searchMemories, searchMemoryPage } from "./search.ts";
export { MemoryError, noMemory } from "./errors.ts";
export {
	isMemoryKind,
	type Memory,
	type MemoryInput,
	type MemoryKind,
	MEMORY_KINDS,
	refuseMemorySecrets,
} from "./record.ts";

/** Token overlap (title + keywords + body) at which a new memory counts as a duplicate of an existing one. */
const DUPLICATE_JACCARD = 0.6;
/** Full-text matches checked per query when looking for a duplicate. */
const DUPLICATE_CANDIDATES = 25;
/** The words a duplicate is judged on: every word but stopwords, so `phase 1` and `phase 2` stay apart. */
const identityTerms = (text: string): string[] => terms(text, Number.POSITIVE_INFINITY, 1);

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

	/** Best matches for the words of `query`, best first (`search.ts`). */
	search(
		query: string,
		scope: ScopeFilter = "all",
		limit = 10,
		exclude: ReadonlySet<number> = new Set(),
		now = Date.now(),
	): MemoryHit[] {
		return searchMemories(this.agentDb, this.context, query, { scope, limit, exclude, now });
	}

	/** The `memory` tool pages ranked matches from the existing full-text index; absent FTS uses its bounded scan. */
	searchPage(query: string, scope: ScopeFilter, offset: number, limit: number): MemoryHit[] | undefined {
		return searchMemoryPage(this.agentDb, this.context, query, { scope, offset, limit });
	}

	/**
	 * Adds a memory, or updates memory `id`. Refuses text that looks like a secret, and a new memory that repeats one in
	 * the same scope (same title, or most of the same words), naming it so the caller can update it instead. An update
	 * that moves a memory to another scope is checked the same way against that scope.
	 */
	set(
		input: MemoryInput & { id?: number; author: string; sourceSession?: string },
		now = Date.now(),
		expectedRevision?: number,
	): { memory: Memory; created: boolean } {
		refuseMemorySecrets(input);
		return this.agentDb.transaction(() =>
			input.id === undefined ? this.insert(input, now) : this.update(input.id, input, now, expectedRevision),
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
		const duplicate = this.duplicateOf(`${title} ${keywords} ${body}`, title);
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
		expectedRevision: number | undefined,
	): { memory: Memory; created: boolean } {
		const current = this.get(id);
		if (!current) throw noMemory(id);
		checkRevision(current, expectedRevision);
		const title = input.title === undefined ? current.title : storedText(input.title);
		if (!title) throw new MemoryError("A memory needs a title.");
		const scope = input.scope ?? current.scope;
		const body = input.body === undefined ? current.body : storedText(input.body);
		const keywords = input.keywords === undefined ? current.keywords : storedText(input.keywords);
		// A retitle, a rewrite or a move to another scope is an insert as far as duplicates go: refuse it when it repeats
		// another memory. A change that leaves them alone (pinning, a kind) never meets old near-duplicates.
		if (scope !== current.scope || title !== current.title || body !== current.body || keywords !== current.keywords) {
			const duplicate = this.duplicateOf(`${title} ${keywords} ${body}`, title, id);
			if (duplicate)
				throw new MemoryError(
					`Similar memory ${memoryLabel(duplicate.id)} exists${scope === current.scope ? "" : ` in ${scope} scope`}: "${duplicate.title}". Update or delete one of them instead.`,
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

	/**
	 * An existing memory in any visible scope (a workspace memory repeating a global one is redundant too) with the same
	 * normalized title, or whose title, keyword and body words (`text`) mostly match, among the full-text matches. A
	 * queued lesson candidate (`file/candidate-tags.ts`) is no saved note: a save never yields to one.
	 */
	private duplicateOf(text: string, title: string, exceptId?: number): Memory | undefined {
		const normalized = normalizeTitle(title);
		const words = identityTerms(text);
		const matches = [
			...this.search(text, "all", DUPLICATE_CANDIDATES),
			...this.search(title, "all", DUPLICATE_CANDIDATES),
		];
		return matches.find(
			(memory) =>
				memory.id !== exceptId &&
				!isCandidate(memory) &&
				((normalized !== "" && normalizeTitle(memory.title) === normalized) ||
					jaccard(words, identityTerms(`${memory.title} ${memory.keywords} ${memory.body}`)) >= DUPLICATE_JACCARD),
		);
	}

	delete(id: number, expectedRevision?: number): Memory {
		return this.agentDb.transaction(() => {
			const current = this.get(id);
			if (!current) throw noMemory(id);
			checkRevision(current, expectedRevision);
			memories.remove(this.db, id);
			return current;
		});
	}

	/** Records that `ids` were handed to the model through the database writer; resolves after commit. */
	async markUsed(ids: readonly number[], now = Date.now()): Promise<void> {
		if (ids.length === 0) return;
		await this.writer().post({ kind: "memory-used", context: this.context, ids: [...ids], now });
	}
}

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
		`author: ${memory.author}${memory.sourceSession ? ` · source session ${memory.sourceSession}` : ""} · updated ${days(memory.updatedAt)} · used ${memory.useCount}×${memory.lastUsed ? ` (last ${days(memory.lastUsed)})` : ""}`,
		"",
		memory.body || "(no body)",
	].join("\n");
}
