import { describe, expect, it } from "vitest";
import {
	averageRequestsPerItem,
	DEFAULT_REQUESTS_PER_ITEM,
	MIN_ITEM_SAMPLE,
} from "../../src/octocode/compaction/done-gain.ts";

describe("requests expected per finished item", () => {
	it("uses the default until enough items finished, however long the few were", () => {
		expect(averageRequestsPerItem([])).toBe(DEFAULT_REQUESTS_PER_ITEM);
		expect(averageRequestsPerItem([40, 30])).toBe(DEFAULT_REQUESTS_PER_ITEM);
	});

	it("averages the session's own items from the minimum sample on", () => {
		const items = Array.from({ length: MIN_ITEM_SAMPLE }, () => 9);
		expect(averageRequestsPerItem(items)).toBe(9);
	});
});
