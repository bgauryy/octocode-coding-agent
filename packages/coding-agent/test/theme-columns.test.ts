import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { columnRows, fitCell, labelValueRows } from "../src/theme/columns.ts";

const rows = [
	["NAME", "PID", "COMMAND"],
	["octocode-agent-main-aaaaaaaa", "2604", "/opt/homebrew/Cellar/node/26.4.0/bin/node packages/octocode-mcp/dist/index.js"],
	["octocode-agent-implementer-nifty-beak", "9", "sleep 8"],
];

describe("columns", () => {
	it("keeps natural widths without a width and trims trailing spaces", () => {
		const lines = columnRows(rows);
		expect(lines[0]).toBe("NAME                             PID   COMMAND");
		expect(lines[2]).toBe("octocode-agent-implementer-nifty-beak  9     sleep 8");
	});

	it.each([60, 100])("never exceeds %d columns and cuts the widest column with an ellipsis", (width) => {
		const lines = columnRows(rows, { width });
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(lines).toHaveLength(rows.length);
		expect(lines[1]).toContain("…");
		// The narrow columns keep their text whole.
		expect(lines[1]).toContain("2604");
	});

	it("aligns right columns and honours indent and min widths", () => {
		expect(
			columnRows(
				[
					["a", "1"],
					["bb", "22"],
				],
				{ indent: "> ", right: [1], min: [4] },
			),
		).toEqual(["> a      1", "> bb    22"]);
	});

	it("cuts a row that still does not fit at the edge", () => {
		const [line] = columnRows([["abcdefghij", "klmnopqrst"]], { width: 8, flex: [] });
		expect(visibleWidth(line)).toBeLessThanOrEqual(8);
	});

	it("fits a cell by padding or cutting", () => {
		expect(fitCell("ab", 4)).toBe("ab  ");
		// A cut cell closes its own styling, so only the visible text is compared.
		expect(stripVTControlCharacters(fitCell("abcdef", 4))).toBe("abc…");
		expect(fitCell("7", 3, "right")).toBe("  7");
	});

	it("lays out label/value rows, keeping continuation lines under the value and cutting wide values", () => {
		const pairs: [string, string][] = [
			["id", "x"],
			["longer label", `${"v".repeat(80)}\nsecond`],
		];
		expect(labelValueRows(pairs)).toEqual([
			"id            x",
			`longer label  ${"v".repeat(80)}`,
			`              second`,
		]);
		const narrow = labelValueRows(pairs, { width: 60 });
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(narrow[1]).toContain("…");
	});
});
