import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { countsText } from "../../src/octocode/backlog/format.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { type FooterState, footerLines } from "../../src/octocode/ui/footer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const state: FooterState = {
	model: "model-x",
	context: { percent: 42, limit: 200_000 },
	usage: { input: 12_400, cacheRead: 0, output: 3_100, cost: 0.84, unpriced: false },
	cwd: "/work/project",
	sessionName: "Fix login",
	compactions: 2,
};

describe("backlog discovery in the native footer", () => {
	it.each([
		{ backlog: 0, todo: 0, ongoing: 0, done: 0 },
		{ backlog: 0, todo: 0, ongoing: 0, done: 5 },
		{ backlog: 3, todo: 4, ongoing: 2, done: 5 },
	])("keeps the web entry point with counts %o", (counts) => {
		const statuses = new Map([[STATUS.backlog, countsText(counts)]]);
		const [top, bottom] = footerLines(state, "main", statuses, theme, 200);
		expect(bottom).toContain("/web · backlogs & activity");
		expect(top).not.toContain("/web");
		expect(bottom).toContain("15.5k tokens");
		expect(bottom).toContain("2 compactions");
		if (counts.ongoing) expect(bottom).toContain("2 ongoing · 4 todo · 3 to triage");
	});

	it("shortens the hint to /web while preserving location and usage at common terminal widths", () => {
		const statuses = new Map([
			[STATUS.backlog, countsText({ backlog: 3, todo: 4, ongoing: 2, done: 5 })],
			["octocode-permission", "permission: manual"],
		]);
		for (const width of [80, 100, 120]) {
			const [top, bottom] = footerLines(state, "main", statuses, theme, width);
			expect(top).toContain("manual");
			expect(bottom).toContain("/web");
			expect(bottom).toContain("project");
			expect(bottom).toContain("15.5k tokens");
		}
		for (const width of [0, 1, 4, 8, 20, 40, 80, 120, 200]) {
			const lines = footerLines(state, "main", statuses, theme, width);
			expect(lines).toHaveLength(2);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});
