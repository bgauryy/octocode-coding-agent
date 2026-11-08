import { beforeAll, describe, expect, test, vi } from "vitest";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { CommandSelectorComponent } from "../src/modes/interactive/components/command-selector.ts";
import { fitHints, HintBar, type RankedHint } from "../src/modes/interactive/components/hint-bar.ts";
import { QueueListComponent } from "../src/modes/interactive/components/queue-list.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const HINTS: RankedHint[] = [
	["enter", "resume", 1],
	["tab", "scope", 3],
	["ctrl+d", "delete", 2],
	["ctrl+s", "sort", 4],
	["esc", "close", 0],
];

describe("HintBar", () => {
	beforeAll(() => initTheme("dark"));

	test.each([30, 40, 80])("renders one line that fits at width %i", (width) => {
		const lines = new HintBar(HINTS).render(width);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
	});

	test("shows every hint at 80 and drops the lowest-ranked first at 40 and 30", () => {
		const shown = (width: number) => stripAnsi(new HintBar(HINTS).render(width)[0]).trim();
		expect(shown(80)).toBe("enter resume · tab scope · ctrl+d delete · ctrl+s sort · esc close");
		expect(shown(50)).toBe("enter resume · ctrl+d delete · esc close");
		expect(shown(40)).toBe("enter resume · esc close");
		expect(shown(30)).toBe("enter resume · esc close");
		expect(shown(20)).toBe("esc close");
	});

	test("keeps the top-ranked hint and cuts it rather than wrapping at a tiny width", () => {
		expect(fitHints(HINTS, 1)).toEqual([["esc", "close"]]);
		const [line] = new HintBar(HINTS).render(6);
		expect(visibleWidth(line)).toBeLessThanOrEqual(6);
	});

	test("hints without a rank are dropped from the end", () => {
		expect(
			fitHints(
				[
					["a", "one"],
					["b", "two"],
					["c", "three"],
				],
				13,
			),
		).toEqual([
			["a", "one"],
			["b", "two"],
		]);
	});

	test("selectors use it: the command picker and the queue list stay one line wide-fit at 30/40/80", () => {
		const picker = new CommandSelectorComponent(
			"Commands",
			[{ name: "help", description: "Find commands" }],
			vi.fn(),
			vi.fn(),
		);
		const queue = new QueueListComponent(vi.fn(), vi.fn());
		queue.setRows([{ mode: "steer", text: "hello", notes: [] }]);
		for (const width of [30, 40, 80]) {
			for (const component of [picker, queue]) {
				const lines = component.render(width).map(stripAnsi);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(lines.some((line) => /esc|escape/i.test(line) && /close/.test(line))).toBe(true);
			}
		}
		expect(stripAnsi(picker.render(80).join("\n"))).toContain("insert command");
	});
});
