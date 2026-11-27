import { describe, expect, it } from "vitest";
import { LineRunsBuilder, matchesWithin } from "../../src/octocode/history/rank/line-runs.ts";

describe("a ranked search's query filter", () => {
	it("keeps a filter that matches every line of a file as one run, whatever the file's length", () => {
		const lines = new LineRunsBuilder();
		for (let line = 0; line < 1_000_000; line++) lines.add(line);
		const runs = lines.done();
		// Eight bytes for a million matched lines; a set of their numbers held each one.
		expect(runs.byteLength).toBe(8);
		expect(matchesWithin(runs, 999_960, 999_999)).toBe(true);
		expect(matchesWithin(runs, 1_000_000, 1_000_039)).toBe(false);
	});

	it("costs at most two numbers a matched line, and answers as the set of matched lines would", () => {
		const matched = new Set<number>();
		const lines = new LineRunsBuilder();
		// Deterministic scatter: runs, single lines and gaps.
		for (let line = 0, seed = 7; line < 20_000; line++) {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			if (seed % 3 === 0) {
				matched.add(line);
				lines.add(line);
			}
		}
		const runs = lines.done();
		expect(runs.length).toBeLessThanOrEqual(matched.size * 2);
		for (let start = 0; start < 20_050; start += 7) {
			const end = start + (start % 40);
			let expected = false;
			for (let at = start; at <= end; at++) if (matched.has(at)) expected = true;
			expect(matchesWithin(runs, start, end)).toBe(expected);
		}
		expect(matchesWithin(undefined, 0, 10)).toBe(false);
	});

	it("refuses matches that arrive out of order instead of losing one", () => {
		const lines = new LineRunsBuilder();
		lines.add(10);
		lines.add(20);
		expect(() => lines.add(5)).toThrow(/out of order/);
	});
});
