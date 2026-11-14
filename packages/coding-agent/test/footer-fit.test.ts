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

	it("right-aligns a single surviving part in spare columns", () => {
		expect(fitFooterLine([], [{ text: "cost", priority: 40 }], paint, 8).line).toBe("    cost");
	});
});
