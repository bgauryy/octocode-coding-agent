import assert from "node:assert/strict";
import { it } from "node:test";
import { RowHeights } from "../src/layout/row-heights.ts";

it("locates every row after variable-height corrections, empty rows, and replacement", () => {
	const index = new RowHeights();
	let seed = 41;
	const next = (limit: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % limit;
	for (const length of [0, 1, 2, 31, 32, 33, 1000]) {
		const heights = Array.from({ length }, () => next(12));
		index.reset(heights);
		for (let step = 0; step < 100; step++) {
			if (length) {
				const at = next(length);
				const height = next(20);
				index.add(at, height - heights[at]);
				heights[at] = height;
			}
			const total = heights.reduce((sum, height) => sum + height, 0);
			for (const row of [0, next(total + 1), total - 1, total, total + 1].filter((row) => row >= 0)) {
				let top = 0;
				let item = 0;
				while (item < heights.length && top + heights[item] <= row) top += heights[item++];
				assert.deepEqual(index.locate(row), { index: item, offset: item < length ? row - top : 0, top });
			}
		}
	}
});
