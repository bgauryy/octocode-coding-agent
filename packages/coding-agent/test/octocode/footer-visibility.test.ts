import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { type FooterState, footerLines } from "../../src/octocode/ui/footer/rows.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const state: FooterState = {
	model: "model-x",
	thinking: "high",
	context: { percent: 42, window: 200_000 },
	usage: { input: 12_400, cacheRead: 0, output: 3_100, cost: 0.84, unpriced: false },
	cwd: "/work/project",
};

describe("footer data visibility", () => {
	it("shows native status keys that do not have a dedicated position", () => {
		const statuses = new Map([
			[STATUS.wakeRetry, { text: "provider retry in 5s", tone: "warning" as const }],
			[STATUS.timers, { text: "timer judging $0.120", tone: "accent" as const }],
		]);
		const output = footerLines(state, "main", statuses, theme, 200).join("\n");
		expect(output).toContain("provider retry in 5s");
		expect(output).toContain("timer judging $0.120");
	});

	it("gives compressed cost and token details a visible command", () => {
		const lines = footerLines(state, "main", new Map(), theme, 60);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).toContain("… /status");
		expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
		expect(footerLines(state, "main", new Map(), theme, 200).join("\n")).not.toContain("/status");
	});

	it.each([40, 80])("wraps complete alerts instead of silently dropping them at %s columns", (width) => {
		const failure = "database unavailable; session remains in memory";
		const statuses = new Map([
			["a-routine", { text: "routine background information" }],
			["z-error", { text: failure, tone: "error" as const }],
		]);
		const lines = footerLines(state, "main", statuses, theme, width);
		// Joining without spaces also covers an unbroken word split by a two-column terminal.
		const shown = lines.join("").replaceAll(" ", "");
		expect(shown).toContain(failure.replaceAll(" ", ""));
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it.each([20, 40, 80])("bounds long alerts and points to their complete status at %s columns", (width) => {
		const statuses = new Map([
			["first", { text: "database unavailable ".repeat(1_000), tone: "error" as const }],
			["second", { text: "provider retry pending", tone: "warning" as const }],
		]);
		const lines = footerLines(state, "main", statuses, theme, width);
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(lines.join("\n")).toContain("error: database");
		// The short warning may fit whole on line 2; only alerts not shown whole are counted.
		const warningShown = lines.slice(0, 2).some((line) => line.includes("provider retry pending"));
		expect(lines.at(-1)).toContain(`+${warningShown ? 1 : 2} alerts · /status`);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it.each([20, 40])("keeps the location and moves a wide warning whole to its own row at %s columns", (width) => {
		const warning = "custom ext status value";
		const statuses = new Map([["ext", { text: warning, tone: "warning" as const }]]);
		const lines = footerLines({ ...state, cwd: "/work/projects/app" }, "main", statuses, theme, width);
		expect(lines[0]).toMatch(/^(app|\/…\/projects\/app|\/work\/projects\/app) ⎇/);
		// Shown once and uncut: either on line 2 or in the alert rows, never a truncated copy on each.
		expect(lines.filter((line) => line.includes("custom ext"))).toHaveLength(1);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("does not duplicate an alert already fully visible in the compact rows", () => {
		const statuses = new Map([["health", { text: "database unavailable", tone: "error" as const }]]);
		const lines = footerLines(state, "main", statuses, theme, 200);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n").match(/database unavailable/g)).toHaveLength(1);
	});

	it("keeps the location and a details route when alerts outgrow their rows", () => {
		const warning = "Retry in 4s · network unavailable";
		const failure = "Database unavailable";
		const statuses = new Map([
			[STATUS.wakeRetry, { text: warning, tone: "warning" as const }],
			["health", { text: failure, tone: "error" as const }],
			["routine", { text: "connected services and background work" }],
		]);
		const lines = footerLines(state, "main", statuses, theme, 40);
		const text = lines.join("\n");
		expect(text).toContain(failure);
		expect(lines[0]).toMatch(/^\/work\/project ⎇ main/);
		expect(lines.at(-1)).toContain("/status");
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it.each([7, 8])("fits the complete compact details command into %s columns without growing", (width) => {
		const lines = footerLines(state, "main", new Map(), theme, width);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("/status");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("indicates routine status details even before the session spends tokens", () => {
		const empty = { ...state, usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false } };
		const statuses = new Map([["extensions", { text: "connected services ".repeat(10) }]]);
		const lines = footerLines(empty, "main", statuses, theme, 60);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("… /status");
	});

	it.each([0, 1])("keeps unusably small rows bounded at %s columns", (width) => {
		const statuses = new Map([["health", { text: "database unavailable", tone: "error" as const }]]);
		expect(footerLines(state, "main", statuses, theme, width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});
