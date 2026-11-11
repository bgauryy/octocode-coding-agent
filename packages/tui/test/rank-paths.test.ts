import assert from "node:assert";
import { describe, it } from "node:test";
import type { IndexedPath } from "../src/autocomplete/file-index.ts";
import { RANK_CHUNK_SIZE, type RankedPath, rankPaths } from "../src/autocomplete/rank-paths.ts";
import { fuzzyMatchPath } from "../src/fuzzy.ts";

/** The ranking as it was before chunking: score every entry synchronously, then sort. */
function referenceRank(entries: readonly IndexedPath[], query: string, limit = 50): RankedPath[] {
	const scored: Array<RankedPath & { score: number }> = [];
	for (const entry of entries) {
		const match = fuzzyMatchPath(query, entry.path);
		if (match) scored.push({ ...entry, positions: match.positions, score: match.score });
	}
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		if (a.path.length !== b.path.length) return a.path.length - b.path.length;
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});
	return scored.slice(0, limit);
}

function syntheticIndex(count: number): IndexedPath[] {
	const words = ["src", "packages", "Editor", "component", "tui", "test", "README", "fuzzy", "İndex", "a-b_c.d"];
	const entries: IndexedPath[] = [];
	for (let i = 0; i < count; i++) {
		const depth = 1 + (i % 4);
		const parts = Array.from({ length: depth }, (_, k) => words[(i * 7 + k * 3) % words.length]);
		const isDirectory = i % 5 === 0;
		entries.push({ path: `${parts.join("/")}${isDirectory ? "" : `/file${i}.ts`}`, isDirectory });
	}
	return entries;
}

describe("rankPaths", () => {
	const entries = syntheticIndex(RANK_CHUNK_SIZE * 3 + 17);

	it("orders matches exactly as the synchronous ranking did", async () => {
		for (const query of ["p", "src", "edcmp", "Editor", "tui/test", "fuzzy/f1", "index", "file12", "zzz", "a-b"]) {
			const ranked = await rankPaths(entries, query);
			assert.deepStrictEqual(
				ranked.map(({ path, isDirectory, positions }) => ({ path, isDirectory, positions })),
				referenceRank(entries, query).map(({ path, isDirectory, positions }) => ({ path, isDirectory, positions })),
				`query ${query}`,
			);
		}
	});

	it("reports every match, so ranking a longer query over them gives the same result", async () => {
		let matched: IndexedPath[] = [];
		await rankPaths(entries, "sr", { onMatches: (all) => (matched = all) });
		assert.strictEqual(matched.length, entries.filter((entry) => fuzzyMatchPath("sr", entry.path)).length);
		assert.deepStrictEqual(await rankPaths(matched, "srcf"), await rankPaths(entries, "srcf"));
	});

	it("yields to the event loop between chunks", async () => {
		let ranTimer = false;
		setImmediate(() => {
			ranTimer = true;
		});
		const ranking = rankPaths(entries, "src");
		assert.strictEqual(ranTimer, false);
		await ranking;
		assert.strictEqual(ranTimer, true);
	});

	it("stops at the next chunk once aborted and reports no matches", async () => {
		const controller = new AbortController();
		let reported = false;
		const ranking = rankPaths(entries, "src", { signal: controller.signal, onMatches: () => (reported = true) });
		controller.abort();
		assert.deepStrictEqual(await ranking, []);
		assert.strictEqual(reported, false);
	});
});
