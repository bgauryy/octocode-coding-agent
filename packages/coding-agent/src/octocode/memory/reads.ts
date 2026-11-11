import { HISTORY_BYTES, matchTexts } from "../history/search.ts";
import { parseMemoryId } from "./query.ts";
import { describeMemory, type Memory, type MemoryStore, memoryToolLine, noMemory, type ScopeFilter } from "./store.ts";

/** The `memory` tool's reads: `get`, `list` and `search` over one store, with one cursor. */

interface MemoryReadParams {
	op: "search" | "list";
	query?: string;
	keywords?: string;
	scope?: ScopeFilter;
	limit?: number;
	cursor?: string;
}

/** Where a read stopped: the last row it consumed in list order, or with `offset` the count of ranked rows consumed. */
interface Position {
	seq: number;
	pinned?: number;
	updated?: number;
	offset?: number;
}

/** Rows fetched per step of a filtered read; one more is fetched to learn whether any remain. */
const CHUNK = 50;
/** Characters of a body on a list or search line. */
const PREVIEW_CHARS = 160;

function positionOf(cursor: string | undefined): Position | undefined {
	if (!cursor) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
	} catch {
		parsed = undefined;
	}
	const at = parsed as Position | undefined;
	const valid =
		at &&
		typeof at === "object" &&
		!Array.isArray(at) &&
		Number.isSafeInteger(at.seq) &&
		at.seq >= 0 &&
		(at.pinned === undefined || [0, 1, 2].includes(at.pinned)) &&
		(at.updated === undefined || Number.isSafeInteger(at.updated)) &&
		(at.offset === undefined || (Number.isSafeInteger(at.offset) && at.offset >= 0));
	if (!valid) throw new Error("Invalid memory cursor; restart the search without cursor.");
	return at;
}

/** The whole memory `id` names (`M7`), counted as used. */
export function getMemory(store: MemoryStore, id: string): string {
	const parsed = parseMemoryId(id);
	if (parsed === undefined) throw new Error(`"${id}" is not a memory id (M<n>).`);
	const memory = store.get(parsed);
	if (!memory) throw noMemory(parsed);
	store.markUsed([memory.id]);
	return describeMemory(memory);
}

/**
 * Lists or searches the memories of `scope`. `keywords` rank through the store's full-text index (word overlap when it
 * has none); `query` is a case-insensitive regular expression tested against every memory of the scope, not one page:
 * rows are read in list order (pinned first, then newest) until `limit` match, the rows end or the scan budget is
 * spent, and the cursor continues after the last row read. A search counts its matches as used; a list does not.
 */
export async function readMemories(
	store: MemoryStore,
	params: MemoryReadParams,
	signal?: AbortSignal,
): Promise<{ text: string; hits: number; cursor?: string }> {
	const start = positionOf(params.cursor);
	const scope = params.scope ?? "all";
	const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
	const filter = params.query?.trim() ? new RegExp(params.query.trim(), "i") : undefined;
	const words = params.keywords?.trim() ? params.keywords.toLowerCase().split(/\s+/).filter(Boolean) : [];
	const found: Array<{ memory: Memory; score?: number }> = [];
	let at = start;
	let scanned = 0;
	let bytes = 0;
	let more = false;
	// The full-text index answers the first ranked page, or says (undefined) that this database has none.
	let ranked = words.length > 0;
	for (let done = false; !done;) {
		signal?.throwIfAborted();
		const offset = at?.offset ?? 0;
		const hits = ranked ? store.searchPage(params.keywords!, scope, offset, CHUNK + 1) : undefined;
		if (ranked && !hits) ranked = false;
		const rows: Array<Memory & { score?: number }> =
			hits ??
			store.scan(
				scope,
				{
					id: at?.seq ?? Number.MAX_SAFE_INTEGER,
					pinned: at?.pinned ?? 2,
					updated: at?.updated ?? Number.MAX_SAFE_INTEGER,
				},
				CHUNK + 1,
			);
		const page = rows.slice(0, CHUNK);
		const texts = page.map((row) => describeMemory(row));
		const matched = filter ? await matchTexts(texts, filter, signal) : undefined;
		done = rows.length <= CHUNK;
		for (const [i, row] of page.entries()) {
			const size = Buffer.byteLength(texts[i]);
			if (bytes + size > HISTORY_BYTES) {
				if (scanned === 0) throw new Error(`M${row.id} exceeds the search budget; get it directly by id.`);
				more = true;
				done = true;
				break;
			}
			bytes += size;
			scanned++;
			at = {
				seq: row.id,
				pinned: Number(row.pinned),
				updated: row.updatedAt,
				...(ranked ? { offset: offset + i + 1 } : {}),
			};
			// Without the index, a keyword search keeps the rows that hold a word, scored by how many.
			const overlap =
				!ranked && words.length > 0 ? words.filter((word) => texts[i].toLowerCase().includes(word)).length : undefined;
			if ((matched && !matched.has(i)) || overlap === 0) continue;
			const score = row.score ?? overlap;
			found.push({ memory: row, ...(score === undefined ? {} : { score }) });
			if (found.length === limit) {
				more = i < rows.length - 1;
				done = true;
				break;
			}
		}
	}
	if (words.length > 0) found.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.memory.id - a.memory.id);
	if (params.op === "search") store.markUsed(found.map((hit) => hit.memory.id));
	const lines = found.map((hit) => `M${hit.memory.id}\n${memoryToolLine(hit.memory, PREVIEW_CHARS)}`);
	const cursor = more && at ? Buffer.from(JSON.stringify(at)).toString("base64url") : undefined;
	return {
		text: `memories: ${found.length} matches in ${scanned} scanned records\n${lines.join("\n\n")}`,
		hits: found.length,
		...(cursor ? { cursor } : {}),
	};
}
