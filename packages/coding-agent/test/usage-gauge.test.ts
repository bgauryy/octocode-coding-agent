import { expect, it } from "vitest";
import { usageCells, usagePercent } from "../src/core/agent-session/usage-gauge.ts";

it("fills a cell for any use and writes <1% beside it, never 0%", () => {
	expect(usageCells(0, 8)).toBe(0);
	expect(usageCells(0.2, 8)).toBe(1);
	expect(usagePercent(0.2)).toBe("<1%");
	expect(usagePercent(0)).toBe("0%");
	expect(usageCells(34, 30)).toBe(10);
	expect(usageCells(150, 8)).toBe(8);
	expect(usagePercent(34.4)).toBe("34%");
});
