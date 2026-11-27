import { itemCounts } from "./counts-fixture.ts";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { countsText } from "../../src/octocode/backlog/format.ts";
import { chipParts } from "../../src/octocode/permission/mode.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { type FooterState, footerLines } from "../../src/octocode/ui/footer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const state: FooterState = {
	model: "model-x",
	context: { percent: 42, window: 200_000 },
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
		const statuses = new Map([[STATUS.backlog, { text: countsText(itemCounts(counts)) }]]);
		const [top, bottom] = footerLines(state, "main", statuses, theme, 200);
		expect(bottom).toContain("/web · backlogs & activity");
		expect(top).not.toContain("/web");
		expect(top).toContain("15.5k tok (↑12.4k ↓3.1k)");
		expect(bottom).toMatch(/^model-x · Fix login · 2 compactions /);
		if (counts.ongoing) expect(bottom).toContain("2 ongoing · 4 todo · 3 backlog");
	});

	it("shows the open counts, never the closed total, and still shortens to the hint", () => {
		const statuses = new Map([
			[STATUS.backlog, { text: countsText(itemCounts({ backlog: 3, todo: 4, ongoing: 2, done: 5 })) }],
		]);
		expect(footerLines(state, "main", statuses, theme, 200)[1]).toContain("2 ongoing · 4 todo · 3 backlog");
		expect(footerLines(state, "main", statuses, theme, 60)[1]).toContain("/web");
	});

	it("shows the step in progress when there is room and drops it before the bar and count", () => {
		const chip = "▰▰▱▱ 2/4 steps · ▶ B12 Run the focused tests for the footer";
		const statuses = new Map([
			[STATUS.backlog, { text: countsText(itemCounts({ backlog: 0, todo: 4, ongoing: 2, done: 0 })) }],
			[STATUS.steps, { text: chip }],
		]);
		expect(footerLines(state, "main", statuses, theme, 200)[1]).toContain(chip);
		const narrow = footerLines(state, "main", statuses, theme, 80)[1];
		expect(narrow).toContain("▰▰▱▱ 2/4 steps");
		expect(narrow).not.toContain("Run the focused");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(80);
	});

	it("keeps completed step progress and the web entry point at ordinary terminal widths", () => {
		const statuses = new Map([
			[STATUS.backlog, { text: countsText(itemCounts({ backlog: 3, todo: 4, ongoing: 2, done: 5 })) }],
			[STATUS.steps, { text: "2/3 steps done · 1 dropped" }],
		]);
		for (const width of [80, 100, 120, 200]) {
			const lines = footerLines(state, "main", statuses, theme, width);
			expect(lines[1]).toContain("2/3 steps done");
			expect(lines[1]).toContain("1 dropped");
			expect(lines[1]).toContain("/web");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("shortens the hint to /web while line 1 keeps the location and usage at common terminal widths", () => {
		const statuses = new Map([
			[STATUS.backlog, { text: countsText(itemCounts({ backlog: 3, todo: 4, ongoing: 2, done: 5 })) }],
		]);
		for (const width of [80, 100, 120]) {
			const [top, bottom] = footerLines({ ...state, chip: chipParts("manual") }, "main", statuses, theme, width);
			expect(top).toContain("manual");
			expect(bottom).toContain("/web");
			expect(top).toMatch(/^\/work\/project ⎇ main · /);
			expect(top).toContain("15.5k tok");
		}
		for (const width of [0, 1, 4, 8, 20, 40, 80, 120, 200]) {
			const lines = footerLines(state, "main", statuses, theme, width);
			expect(lines).toHaveLength(2);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});
