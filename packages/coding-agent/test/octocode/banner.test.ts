import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { type BannerPaint, bannerLines, ISSUES_URL } from "../../src/octocode/ui/banner.ts";
import { backlogStatusLine } from "../../src/octocode/ui/backlog-status.ts";
import type { BacklogCounts } from "../../src/octocode/backlog/counts.ts";

const counts = (
	items: Partial<BacklogCounts["items"]>,
	epics: Partial<BacklogCounts["epics"]> = {},
): BacklogCounts => ({
	items: { backlog: 0, todo: 0, ongoing: 0, done: 0, ...items },
	epics: { backlog: 0, todo: 0, ongoing: 0, done: 0, ...epics },
	closed: 0,
});

const plain: BannerPaint = { fg: (_color, text) => text };
const NOTICE = `BETA version ; please assign issues here ${ISSUES_URL}`;

describe('banner "OCTOCODE AGENT"', () => {
	it("is only the half-block art and the beta notice", () => {
		const lines = bannerLines(plain, 120);
		expect(lines).toEqual([
			"█▀█ █▀▀ ▀█▀ █▀█ █▀▀ █▀█ █▀▄ █▀▀   ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀",
			"█▄█ █▄▄  █  █▄█ █▄▄ █▄█ █▄▀ ██▄   █▀█ █▄█ ██▄ █ ▀█  █ ",
			NOTICE,
		]);
		expect(ISSUES_URL).toBe("https://github.com/bgauryy/octocodecode/issues");
		expect(lines.join("\n")).not.toMatch(/research-driven|\/status|interrupt/);
	});

	it("falls back to theme tokens without a gradient: OCTOCODE accent, AGENT mdLink", () => {
		const painted: Array<[string, string]> = [];
		bannerLines(
			{
				fg: (color, text) => {
					painted.push([color, text]);
					return text;
				},
			},
			120,
		);
		expect(painted.some(([color, text]) => color === "accent" && text.includes("█"))).toBe(true);
		expect(painted.some(([color, text]) => color === "mdLink" && text.includes("█"))).toBe(true);
		expect(painted).toContainEqual(["mdLink", ISSUES_URL]);
	});

	it("paints the art along a left-to-right gradient", () => {
		const positions: number[] = [];
		bannerLines(
			{
				fg: (_c, text) => text,
				ramp: (t, text) => {
					positions.push(t);
					return text;
				},
			},
			120,
		);
		expect(positions[0]).toBe(0);
		expect(Math.max(...positions)).toBe(1);
	});

	it("adds one backlog line under the notice: counts by state, zeros left out, done includes done epics", () => {
		const line = backlogStatusLine(
			plain,
			counts({ ongoing: 3, todo: 6, backlog: 44, done: 118 }, { todo: 1, ongoing: 1, done: 2 }),
		);
		expect(line).toBe("Backlog  ▶ 3 ongoing · ☐ 6 to do · ⧗ 44 proposed · ◆ 2 epics · ✓ 120 done");
		expect(backlogStatusLine(plain, counts({ todo: 1 }))).toBe("Backlog  ☐ 1 to do");
		expect(backlogStatusLine(plain, counts({}))).toBeUndefined();
		const lines = bannerLines(plain, 120, (paint) => backlogStatusLine(paint, counts({ ongoing: 1 })));
		expect(lines).toHaveLength(4);
		expect(lines[3]).toBe("Backlog  ▶ 1 ongoing");
		// An empty board adds no line.
		expect(bannerLines(plain, 120, (paint) => backlogStatusLine(paint, counts({})))).toHaveLength(3);
		for (const width of [1, 20, 46]) {
			const narrow = bannerLines(plain, width, (paint) => backlogStatusLine(paint, counts({ ongoing: 3, todo: 6 })));
			expect(narrow).toHaveLength(4);
			expect(narrow.every((row) => visibleWidth(row) <= width)).toBe(true);
		}
	});

	it("keeps one height at every width and fits each line, with the plain name below the art's width", () => {
		expect(bannerLines(plain, 30)[0]).toBe("OCTOCODE AGENT");
		for (const width of [1, 4, 20, 46, 47, 80, 200]) {
			const lines = bannerLines(plain, width);
			// A resize never changes the rows above the transcript, so it never forces a scrollback redraw by itself.
			expect(lines, `width ${width}`).toHaveLength(3);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});
