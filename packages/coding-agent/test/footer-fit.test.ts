import { visibleWidth } from "@octocodeai/octocode-tui/text";
import { describe, expect, it } from "vitest";
import { fitFooterLine } from "../src/octocode/ui/footer/fit.ts";

const paint = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };

describe("footer column allocation", () => {
	it("uses the whole row when the only surviving part is on the right", () => {
		const fitted = fitFooterLine([], [{ text: "≈$1.25", priority: 40, details: true }], paint, 6);
		expect(fitted).toEqual({ line: "≈$1.25", detailsHidden: false });
	});

	it("keeps a right-side alert after dropping lower priority left text", () => {
		const fitted = fitFooterLine(
			[{ text: "model", priority: 10 }],
			[{ text: "失败", priority: 100, keep: true, details: true }],
			paint,
			4,
		);
		expect(fitted).toEqual({ line: "失败", detailsHidden: false });
		expect(visibleWidth(fitted.line)).toBe(4);
	});

	it("brings a dropped part back ahead of a lower-priority part's full form", () => {
		const parts = [
			{ text: "~/code/octocode/packages/agent/src", priority: 100, keep: true, short: "src" },
			{ text: "170k tokens", priority: 80 },
			{ text: "backlog 3 ongoing", priority: 20, keep: true, short: "/web" },
		];
		// The tokens drop before the path shortens; once it has, they fit again and outrank the backlog's full text.
		expect(fitFooterLine(parts, [], paint, 30).line).toBe("src · 170k tokens · /web");
	});

	it("tries the middle form before the short one", () => {
		const place = {
			text: "~/code/octocode/packages/agent/src",
			priority: 100,
			keep: true,
			middle: "~/…/agent/src",
			short: "src",
		};
		expect(fitFooterLine([place, { text: "main", priority: 90, keep: true }], [], paint, 24).line).toBe(
			"~/…/agent/src · main",
		);
		expect(fitFooterLine([place], [], paint, 10).line).toBe("src");
	});

	it("right-aligns a single surviving part in spare columns", () => {
		expect(fitFooterLine([], [{ text: "cost", priority: 40 }], paint, 8).line).toBe("    cost");
	});
});
