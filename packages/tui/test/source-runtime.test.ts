import { spawnSync } from "node:child_process";
import assert from "node:assert";
import { it } from "node:test";

it("loads the highlight cache with the source runtime's native TypeScript stripping", () => {
	const cacheUrl = new URL("../src/components/markdown/highlight-cache.ts", import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
		import assert from "node:assert/strict";
		import { HighlightCache } from ${JSON.stringify(cacheUrl)};
		const cache = new HighlightCache(2, 100);
		cache.set("a", ["A"]);
		cache.set("b", ["B"]);
		assert.deepEqual(cache.get("a"), ["A"]);
		cache.set("c", ["C"]);
		assert.equal(cache.get("b"), undefined);
		cache.set("oversized", ["x".repeat(101)]);
		assert.equal(cache.get("oversized"), undefined);
		assert.deepEqual(cache.get("c"), ["C"]);
	`,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
	assert.strictEqual(child.status, 0, child.stderr);
});
