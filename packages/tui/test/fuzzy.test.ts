import assert from "node:assert";
import { describe, it } from "node:test";
import { fuzzyFilter, fuzzyMatch, fuzzyMatchPath } from "../src/fuzzy.ts";

describe("fuzzyMatch", () => {
	it("empty query matches everything with score 0", () => {
		const result = fuzzyMatch("", "anything");
		assert.strictEqual(result.matches, true);
		assert.strictEqual(result.score, 0);
	});

	it("query longer than text does not match", () => {
		const result = fuzzyMatch("longquery", "short");
		assert.strictEqual(result.matches, false);
	});

	it("exact match has good score", () => {
		const result = fuzzyMatch("test", "test");
		assert.strictEqual(result.matches, true);
		assert.ok(result.score < 0); // Should be negative due to consecutive bonuses
	});

	it("characters must appear in order", () => {
		const matchInOrder = fuzzyMatch("abc", "aXbXc");
		assert.strictEqual(matchInOrder.matches, true);

		const matchOutOfOrder = fuzzyMatch("abc", "cba");
		assert.strictEqual(matchOutOfOrder.matches, false);
	});

	it("case insensitive matching", () => {
		const result = fuzzyMatch("ABC", "abc");
		assert.strictEqual(result.matches, true);

		const result2 = fuzzyMatch("abc", "ABC");
		assert.strictEqual(result2.matches, true);
	});

	it("consecutive matches score better than scattered matches", () => {
		const consecutive = fuzzyMatch("foo", "foobar");
		const scattered = fuzzyMatch("foo", "f_o_o_bar");

		assert.strictEqual(consecutive.matches, true);
		assert.strictEqual(scattered.matches, true);
		assert.ok(consecutive.score < scattered.score);
	});

	it("word boundary matches score better", () => {
		const atBoundary = fuzzyMatch("fb", "foo-bar");
		const notAtBoundary = fuzzyMatch("fb", "afbx");

		assert.strictEqual(atBoundary.matches, true);
		assert.strictEqual(notAtBoundary.matches, true);
		assert.ok(atBoundary.score < notAtBoundary.score);
	});

	it("matches swapped alpha numeric tokens", () => {
		const result = fuzzyMatch("codex52", "gpt-5.2-codex");
		assert.strictEqual(result.matches, true);
	});
});

describe("fuzzyFilter", () => {
	it("empty query returns all items unchanged", () => {
		const items = ["apple", "banana", "cherry"];
		const result = fuzzyFilter(items, "", (x: string) => x);
		assert.deepStrictEqual(result, items);
	});

	it("filters out non-matching items", () => {
		const items = ["apple", "banana", "cherry"];
		const result = fuzzyFilter(items, "an", (x: string) => x);
		assert.ok(result.includes("banana"));
		assert.ok(!result.includes("apple"));
		assert.ok(!result.includes("cherry"));
	});

	it("sorts results by match quality", () => {
		const items = ["a_p_p", "app", "application"];
		const result = fuzzyFilter(items, "app", (x: string) => x);

		// "app" should be first (exact consecutive match at start)
		assert.strictEqual(result[0], "app");
	});

	it("prioritizes exact matches over longer prefix matches", () => {
		const items = ["clone", "cl"];
		const result = fuzzyFilter(items, "cl", (x: string) => x);

		assert.deepStrictEqual(result, ["cl", "clone"]);
	});

	it("works with custom getText function", () => {
		const items = [
			{ name: "foo", id: 1 },
			{ name: "bar", id: 2 },
			{ name: "foobar", id: 3 },
		];
		const result = fuzzyFilter(items, "foo", (item: { name: string; id: number }) => item.name);

		assert.strictEqual(result.length, 2);
		assert.ok(result.map((r) => r.name).includes("foo"));
		assert.ok(result.map((r) => r.name).includes("foobar"));
	});

	it("matches slash-separated provider/model queries against reordered text", () => {
		const item = { id: "gpt-5.5", provider: "openai-codex" };
		const result = fuzzyFilter([item], "openai-codex/gpt-5.5", (model) => `${model.id} ${model.provider}`);

		assert.deepStrictEqual(result, [item]);
	});
});

describe("fuzzyMatchPath", () => {
	const best = (query: string, paths: string[]) =>
		paths
			.map((path) => ({ path, match: fuzzyMatchPath(query, path) }))
			.filter((entry) => entry.match)
			.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
			.map((entry) => entry.path);

	it("returns the matched positions in ascending order", () => {
		const match = fuzzyMatchPath("edtcmp", "src/editor-component.ts");
		assert.ok(match);
		assert.deepStrictEqual(match.positions.map((position) => "src/editor-component.ts"[position]).join(""), "edtcmp");
		assert.deepStrictEqual(
			match.positions,
			[...match.positions].sort((a, b) => a - b),
		);
	});

	it("returns null when the query is not a subsequence", () => {
		assert.strictEqual(fuzzyMatchPath("zzz", "src/editor.ts"), null);
		assert.strictEqual(fuzzyMatchPath("tse", "src/editor.ts"), null);
	});

	it("prefers a basename hit over a scattered path hit", () => {
		assert.strictEqual(best("comp", ["components/x/y/zzz.ts", "src/other/component.ts"])[0], "src/other/component.ts");
		assert.strictEqual(best("main", ["m/a/i/n/file.ts", "src/main.ts"])[0], "src/main.ts");
	});

	it("rewards segment starts, camelCase humps and boundaries", () => {
		assert.strictEqual(best("ec", ["src/xexc.ts", "src/editor-component.ts"])[0], "src/editor-component.ts");
		assert.strictEqual(best("fb", ["src/fabric.ts", "src/fooBar.ts"])[0], "src/fooBar.ts");
		assert.strictEqual(best("ab", ["src/xaxb.ts", "src/a_b.ts"])[0], "src/a_b.ts");
	});

	it("prefers consecutive runs", () => {
		assert.strictEqual(best("abc", ["a-x-b-x-c.ts", "xabc.ts"])[0], "xabc.ts");
	});

	it("penalizes depth and length for equal matches", () => {
		assert.deepStrictEqual(best("util", ["a/b/c/util.ts", "util.ts", "a/util.ts"]), [
			"util.ts",
			"a/util.ts",
			"a/b/c/util.ts",
		]);
	});

	it("anchors segments around a slash in the query", () => {
		const match = fuzzyMatchPath("src/ed", "src/editor.ts");
		assert.ok(match);
		assert.deepStrictEqual(match.positions, [0, 1, 2, 3, 4, 5]);
		assert.strictEqual(fuzzyMatchPath("sr/ed", "s/r/ed.ts"), null);
		assert.ok(fuzzyMatchPath("src/ed", "src/a/editor.ts"));
		assert.strictEqual(best("tui/ed", ["tui-x/other/ed.ts", "packages/tui/ed.ts"])[0], "packages/tui/ed.ts");
	});

	it("is case-insensitive unless the query has an uppercase letter", () => {
		assert.ok(fuzzyMatchPath("readme", "README.md"));
		assert.ok(fuzzyMatchPath("README", "README.md"));
		assert.strictEqual(fuzzyMatchPath("Readme", "readme.md"), null);
	});

	it("matches everything for an empty query", () => {
		assert.deepStrictEqual(fuzzyMatchPath("", "a.ts"), { score: 0, positions: [] });
	});
});
