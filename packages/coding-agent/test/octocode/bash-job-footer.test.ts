import { describe, expect, it } from "vitest";
import { type WorkRow, workCounts } from "../../src/octocode/shared/running-work.ts";

const NOW = 1_000_000;
const job = (id: string, title: string, ago: number): WorkRow => ({
	kind: "bash",
	id,
	title,
	startedAt: NOW - ago,
});

describe("footer: running bash jobs", () => {
	it("names the newest job's command and its elapsed time after the count", () => {
		const text = workCounts(0, [job("bash-1", "yarn build", 90_000), job("bash-2", "yarn test", 5_000)], 0, NOW);
		expect(text).toBe("2 bash · yarn test 5s");
	});

	it("stays the plain count when no clock is given", () => {
		expect(workCounts(0, [job("bash-1", "yarn build", 90_000)])).toBe("1 bash");
	});

	it("clips a long command and uses its first line", () => {
		const text = workCounts(0, [job("bash-1", `${"x".repeat(80)}\nsecond`, 3_000)], 0, NOW);
		expect(text.startsWith("1 bash · ")).toBe(true);
		expect(text).not.toContain("second");
		expect(text.length).toBeLessThan(60);
	});

	it("changes with the clock, so the footer ticks", () => {
		const rows = [job("bash-1", "sleep 100", 5_000)];
		expect(workCounts(0, rows, 0, NOW)).not.toBe(workCounts(0, rows, 0, NOW + 2_000));
	});
});
