import { renderInstruction } from "../../core/prompt-template.ts";
import { USER_AUTHOR } from "../../../../db/src/api.ts";
import { clipText, contentText } from "../shared/util.ts";
import { clearsFloor, MAX_QUERY_TERMS, memoryLabel, stem, terms } from "./query.ts";
import {
	type Memory,
	type MemoryKind,
	type MemoryStore,
	memoryGetCall,
	memoryTags,
	type ScopeFilter,
} from "./store.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { BranchIndex, type BranchSource } from "../shared/branch-index.ts";

export const MEMORY_MESSAGE_TYPE = "octocode-memory";
export const MEMORY_HEADER = renderInstruction("notices/memory-header.md", { again: false });
/** The header of a later injection, while one with the whole caveat is still in context (`headerInContext`). */
export const MEMORY_HEADER_AGAIN = renderInstruction("notices/memory-header.md", { again: true });

/** Characters of pinned memory lines per injection, and of the whole injected message (header and notes included). */
export const PINNED_BUDGET = 1200;
export const TOTAL_BUDGET = 2400;
/** Unseen pinned memories read per injection: more than the shortest lines that fit `PINNED_BUDGET`. */
const PINNED_WINDOW = 50;
/** Hits fetched per wanted one: the relevance filter drops some, so irrelevant top hits must not crowd out relevant lower ones. */
const SEARCH_WINDOW = 3;
/** A hit scoring below this share of the best hit is noise. */
const RELATIVE_THRESHOLD = 0.3;
/** Shorter prompt words (`ts`, `ok`) match too much by chance to pull a memory in. */
const MIN_TERM_LENGTH = 3;
/** Longest line one memory takes in an injection; a longer one ends with where to read it whole. */
const LINE_MAX = 600;
/** Characters reserved for a body when the title needs clipping too. */
const BODY_RESERVE = 80;

interface Injection {
	content: string;
	ids: number[];
	/** Each injected memory's `updatedAt`, in `ids` order: an edit after this makes it new again. */
	updated: number[];
}

/**
 * Ids injected earlier on this branch, each with the `updatedAt` of the version injected (undefined for an injection
 * that did not record it), from the `octocode-memory` custom messages in `entries`, oldest first. A compaction
 * summarizes the messages before its first kept entry away, so only injections from that entry on count (all of them
 * are dropped when the kept entry is unknown). An omitted or changed injection no longer suppresses recall.
 */
export function injectedIds(entries: readonly unknown[]): Map<number, number | undefined> {
	return new Map(keptInjections(entries).flatMap((injection) => (injection.intact ? injection.ids : [])));
}

/**
 * Whether an injection that opens with the whole caveat (`MEMORY_HEADER`) is still in context on this branch, by the
 * same rule as `injectedIds`: a later injection then opens with `MEMORY_HEADER_AGAIN`. After a compaction that kept
 * none, or kept only later ones, the next injection states the caveat whole again.
 */
export function headerInContext(entries: readonly unknown[]): boolean {
	return keptInjections(entries).some((injection) => injection.whole);
}

type KeptInjection = {
	at: number;
	id: string | undefined;
	content: string;
	ids: Array<[number, number | undefined]>;
	intact: boolean;
	whole: boolean;
};

/** A fold of a branch into the injections a compaction has not summarized away (`keptInjections`). */
interface InjectionFold {
	/** How many entries the fold has read: the next entry's position. */
	read: number;
	/** Each entry's position by id, so a compaction can find its first kept entry. */
	readonly position: Map<string, number>;
	injections: KeptInjection[];
}

const startFold = (): InjectionFold => ({ read: 0, position: new Map(), injections: [] });

function foldInjection(fold: InjectionFold, entry: unknown): void {
	const at = fold.read++;
	if (!isRecord(entry)) return;
	if (typeof entry.id === "string") fold.position.set(entry.id, at);
	if (entry.type === "compaction") {
		const kept = typeof entry.firstKeptEntryId === "string" ? fold.position.get(entry.firstKeptEntryId) : undefined;
		fold.injections = kept === undefined ? [] : fold.injections.filter((injection) => injection.at >= kept);
		return;
	}
	if (entry.type === "context_edit") {
		if (typeof entry.targetId !== "string") return;
		const injection = fold.injections.find((injection) => injection.id === entry.targetId);
		if (injection) {
			const replacement = asRecord(entry.replacement).content;
			const text = contentText(replacement);
			injection.intact = entry.replacement !== null && text === injection.content;
			injection.whole = text.startsWith(MEMORY_HEADER);
		}
		return;
	}
	if (entry.type !== "custom_message" || entry.customType !== MEMORY_MESSAGE_TYPE) return;
	const details = asRecord(entry.details);
	const list = Array.isArray(details.ids) ? details.ids : [];
	const updated = Array.isArray(details.updated) ? details.updated : [];
	const content = contentText(entry.content);
	fold.injections.push({
		at,
		id: typeof entry.id === "string" ? entry.id : undefined,
		content,
		intact: true,
		whole: content.startsWith(MEMORY_HEADER),
		ids: list.flatMap((id, index): Array<[number, number | undefined]> =>
			typeof id === "number" ? [[id, typeof updated[index] === "number" ? updated[index] : undefined]] : [],
		),
	});
}

/** The injections a compaction has not summarized away, oldest first. */
function keptInjections(entries: readonly unknown[]): KeptInjection[] {
	const fold = startFold();
	for (const entry of entries) foldInjection(fold, entry);
	return fold.injections;
}

const injectionIndex = new BranchIndex<InjectionFold>(startFold, foldInjection);

/**
 * `injectedIds` and `headerInContext` of the session's current branch, read once per prompt: the branch is folded only
 * from where the last prompt's read ended (`BranchIndex`), and again from its start on another branch.
 */
export function sessionInjections(session: BranchSource): {
	injected: Map<number, number | undefined>;
	headerInContext: boolean;
} {
	const kept = injectionIndex.read(session).injections;
	return {
		injected: new Map(kept.flatMap((injection) => (injection.intact ? injection.ids : []))),
		headerInContext: kept.some((injection) => injection.whole),
	};
}

/** Of the `injected` ids, those whose memory is unchanged since: a memory edited after its injection is sent again. */
export function unchangedIds(
	store: Pick<MemoryStore, "updatedAt">,
	injected: ReadonlyMap<number, number | undefined>,
): Set<number> {
	const current = store.updatedAt([...injected.keys()]);
	return new Set([...injected].flatMap(([id, at]) => (at === undefined || current.get(id) === at ? [id] : [])));
}

/** The content of the latest `octocode-memory` message in `entries`, for `/memory last`. */
export function lastInjection(entries: readonly unknown[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (isRecord(entry) && entry.type === "custom_message" && entry.customType === MEMORY_MESSAGE_TYPE)
			return typeof entry.content === "string" ? entry.content : undefined;
	}
	return undefined;
}

/**
 * What to inject before a prompt: pinned memories (up to `PINNED_BUDGET` chars; skipped with `pinned: false`, only
 * those of `pinnedKind` when it is set), then the top `topK` BM25 hits for the prompt's words of 3+ letters that clear the absolute floor (`clearsFloor`) and score at least
 * `RELATIVE_THRESHOLD` of the best such hit, the whole message (header and held-back note too) within `TOTAL_BUDGET`,
 * skipping `seen` ids. An empty `query` injects pinned memories only. Undefined when nothing
 * new qualifies. The first line is the caveat, whole unless `headerInContext` says an earlier injection still shows it.
 */
export function selectInjection(
	store: MemoryStore,
	options: {
		query: string;
		scope: ScopeFilter;
		seen: ReadonlySet<number>;
		topK: number;
		pinned?: boolean;
		/** Only pinned memories of this kind are injected as pins and counted as held back; hits are not narrowed. */
		pinnedKind?: MemoryKind;
		/** The whole caveat is already in context (`headerInContext`): open with the short header. */
		headerInContext?: boolean;
		now?: number;
	},
): Injection | undefined {
	const now = options.now ?? Date.now();
	const lines: string[] = [];
	const ids: number[] = [];
	const updated: number[] = [];
	const header = options.headerInContext === true ? MEMORY_HEADER_AGAIN : MEMORY_HEADER;
	// The whole message counts toward `TOTAL_BUDGET`: the header, each line and its newline, and the held-back note.
	let used = header.length;
	let pinnedUsed = 0;
	const take = (memory: Memory, pinned: boolean): boolean => {
		if (options.seen.has(memory.id) || ids.includes(memory.id)) return false;
		const line = injectedLine(memory, now);
		if (used + line.length + 1 > TOTAL_BUDGET) return false;
		if (pinned && pinnedUsed + line.length + 1 > PINNED_BUDGET) return false;
		lines.push(line);
		ids.push(memory.id);
		updated.push(memory.updatedAt);
		used += line.length + 1;
		if (pinned) pinnedUsed += line.length + 1;
		return true;
	};
	// Pinned memories that do not fit wait for a later prompt; the model is told how many instead of meeting silence. Seen
	// ones are left out of the listing, so each prompt reaches the next ones, and the count covers every one held back.
	let heldBack = 0;
	if (options.pinned !== false) {
		const unseen = {
			pinnedOnly: true,
			exclude: options.seen,
			...(options.pinnedKind ? { kind: options.pinnedKind } : {}),
		};
		for (const memory of store.list(options.scope, PINNED_WINDOW, unseen)) take(memory, true);
		heldBack = store.count(options.scope, unseen) - ids.length;
	}
	const note =
		heldBack > 0
			? [renderInstruction("notices/memory-held-back.md", { count: heldBack, several: heldBack !== 1 })]
			: [];
	for (const line of note) used += line.length + 1;
	const words = terms(options.query, MAX_QUERY_TERMS, MIN_TERM_LENGTH);
	const stems = new Set(words.map(stem));
	const found =
		words.length > 0
			? store.search(words.join(" "), options.scope, options.topK * SEARCH_WINDOW, new Set([...options.seen, ...ids]))
			: [];
	const hits = found.filter((hit) => clearsFloor(hit, stems));
	const best = hits[0]?.score ?? 0;
	let added = 0;
	for (const hit of hits) {
		if (added >= options.topK || hit.score < best * RELATIVE_THRESHOLD) break;
		if (take(hit, false)) added++;
	}
	if (ids.length === 0) return undefined;
	return { content: [header, ...lines, ...note].join("\n"), ids, updated };
}

/**
 * One memory on one line within `LINE_MAX`: its label, tags with its age, `(agent-written)` unless the user wrote it, then
 * the title and the body, each as one JSON string. The quotes and escapes keep either from ending its line, imitating
 * another entry or reading as a directive. A body that does not fit is cut and ends with the call that reads it whole.
 */
function injectedLine(memory: Memory, now: number): string {
	const flat = (text: string) => text.replace(/\s+/g, " ").trim();
	const prefix = `${memoryLabel(memory.id)} (${memoryTags(memory, now)})${memory.author === USER_AUTHOR ? "" : " (agent-written)"} `;
	const title = flat(memory.title);
	const head = `${prefix}${JSON.stringify(title)}`;
	const body = flat(memory.body);
	const line = `${head}${body ? ` — ${JSON.stringify(body)}` : ""}`;
	if (line.length <= LINE_MAX) return line;
	const pointer = ` (${memoryGetCall(memory.id)})`;
	const room = LINE_MAX - prefix.length - pointer.length;
	// Leave room for the body when an oversized title competes with it. The stored memory stays whole.
	const quotedTitle = boundedQuote(title, body ? room - BODY_RESERVE - 3 : room);
	const quotedBody = body ? ` — ${boundedQuote(body, room - quotedTitle.length - 3)}` : "";
	return `${prefix}${quotedTitle}${quotedBody}${pointer}`;
}

/** Clip the text before quoting, counting JSON escapes too, while preserving complete quotes and code points. */
function boundedQuote(text: string, budget: number): string {
	let low = 0;
	let high = Math.min(text.length, Math.max(0, budget - 2));
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (JSON.stringify(clipText(text, mid)).length <= budget) low = mid;
		else high = mid - 1;
	}
	return JSON.stringify(clipText(text, low));
}
