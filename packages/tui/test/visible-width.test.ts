import assert from "node:assert";
import { describe, it } from "node:test";
import { clearWidthCache, visibleWidth } from "../src/utils/width.ts";

describe("visibleWidth", () => {
	it("measures styled ASCII without counting escape sequences", () => {
		assert.strictEqual(visibleWidth("\x1b[38;5;4mhello\x1b[39m world"), 11);
		assert.strictEqual(visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), 4);
		assert.strictEqual(visibleWidth("\x1b]133;A\x1b\\prompt"), 6);
		assert.strictEqual(visibleWidth("\x1b_octo:c\x1b\\cursor"), 6);
	});

	it("counts tabs as three columns in styled text", () => {
		assert.strictEqual(visibleWidth("\x1b[1ma\tb\x1b[22m"), 5);
	});

	it("measures styled non-ASCII text", () => {
		assert.strictEqual(visibleWidth("\x1b[31m日本\x1b[39m ok"), 7);
		assert.strictEqual(visibleWidth("\x1b[31m─→\x1b[39m"), 2);
	});

	it("treats unterminated escape sequences as zero-width control characters", () => {
		assert.strictEqual(visibleWidth("\x1b[31"), 3);
		assert.strictEqual(visibleWidth("a\x1b"), 1);
	});

	it("returns the same width for a long row measured again, cached or not", () => {
		clearWidthCache();
		const styled = `\x1b[1m${"word ".repeat(30)}\x1b[22m`;
		const wide = `${"日本語 ".repeat(20)}end`;
		const first = [visibleWidth(styled), visibleWidth(wide)];
		assert.deepStrictEqual(first, [150, 143]);
		assert.deepStrictEqual([visibleWidth(styled), visibleWidth(wide)], first);
		clearWidthCache();
		assert.deepStrictEqual([visibleWidth(styled), visibleWidth(wide)], first);
	});

	it("stays correct while more rows than the cache holds (it starts over when full) are measured", () => {
		clearWidthCache();
		const rows = Array.from({ length: 3000 }, (_, i) => `\x1b[3${i % 8}m${String(i).padStart(30, "x")}\x1b[39m`);
		for (const row of rows) assert.strictEqual(visibleWidth(row), 30);
		// Rows from before the cache started over are measured again; the newest are answered from the cache.
		for (const row of [rows[0], rows[1500], rows[2999]]) assert.strictEqual(visibleWidth(row), 30);
		// Rows over the cache's length bound are measured every time.
		const long = `\x1b[2m${"y".repeat(3000)}\x1b[22m`;
		assert.strictEqual(visibleWidth(long), 3000);
		assert.strictEqual(visibleWidth(long), 3000);
	});
});
