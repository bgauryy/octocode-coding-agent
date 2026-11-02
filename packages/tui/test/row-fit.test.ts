import assert from "node:assert";
import { describe, it } from "node:test";
import { fitRows, type RowColumn } from "../src/components/row-fit.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { visibleWidth } from "../src/utils/width.ts";

const columns: RowColumn[] = [{ priority: 100 }, { priority: 90, flex: true }, { priority: 70 }, { priority: 30 }];
const rows = [
	["B2", "Bundle the model catalog into the installer", "3 tasks", "#release"],
	["B10", "Rewrite the release checklist", "", "#docs"],
];
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

describe("fitRows", () => {
	it("aligns columns across rows when everything fits", () => {
		const { lines, kept } = fitRows(rows, columns, 100);
		assert.deepStrictEqual(kept, [true, true, true, true]);
		const [first, second] = plain(lines);
		assert.strictEqual(first.indexOf("Bundle"), second.indexOf("Rewrite"));
		assert.strictEqual(first.indexOf("3 tasks"), second.indexOf("#docs") - "3 tasks ".length);
		assert.strictEqual(first.indexOf("#release"), second.indexOf("#docs"));
	});

	it("shrinks the flex column to its floor before dropping the lowest-priority column", () => {
		assert.deepStrictEqual(fitRows(rows, columns, 80).kept, [true, true, true, true]);
		// 60 wide: the title gives up 5 cells and every column stays.
		assert.deepStrictEqual(fitRows(rows, columns, 60).kept, [true, true, true, true]);
		const mid = fitRows(rows, columns, 30);
		assert.deepStrictEqual(mid.kept, [true, true, true, false]);
		const narrow = fitRows(rows, columns, 20);
		assert.deepStrictEqual(narrow.kept, [true, true, false, false]);
		for (const line of mid.lines) assert.ok(visibleWidth(line) <= 30);
		for (const line of narrow.lines) assert.ok(visibleWidth(line) <= 20);
	});

	it("cuts only the flex column with an ellipsis and never overflows", () => {
		for (let width = 1; width <= 100; width++) {
			for (const line of fitRows(rows, columns, width).lines)
				assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
		const [first] = plain(fitRows(rows, columns, 36).lines);
		assert.ok(first.startsWith("B2 "));
		assert.ok(first.includes("…"));
	});

	it("gives a column no room when no row has text in it", () => {
		const { lines, kept } = fitRows(
			[
				["B1", "alpha", "", ""],
				["B2", "beta", "", ""],
			],
			columns,
			40,
		);
		assert.deepStrictEqual(kept, [true, true, false, false]);
		assert.deepStrictEqual(plain(lines), ["B1 alpha", "B2 beta"]);
	});

	it("counts wide characters by their cells and never splits one", () => {
		const cjk = [["B6", "修复登录页面在中文环境下的超时问题 🔐 timeout", "", ""]];
		for (let width = 4; width <= 50; width++) {
			const [line] = fitRows(cjk, columns, width).lines;
			assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			assert.ok(!line.includes("\ufffd"));
		}
		const [row] = fitRows([...cjk, ["B1", "x", "", ""]], columns, 30).lines;
		assert.ok(row.includes("…"));
	});

	it("right-aligns a column and keeps ANSI styling out of the width", () => {
		const styled = [
			["B2", "\x1b[31mred title\x1b[0m", "\x1b[2m3\x1b[0m"],
			["B10", "blue", "12"],
		];
		const cols: RowColumn[] = [{ priority: 3 }, { priority: 2, flex: true }, { priority: 1, align: "right" }];
		const { lines } = fitRows(styled, cols, 40);
		const [first, second] = plain(lines);
		assert.strictEqual(first.length, second.length);
		assert.ok(first.endsWith(" 3"));
		assert.ok(second.endsWith("12"));
	});

	it("fits a grid without a flex column by dropping columns, then cutting the last one", () => {
		const help: RowColumn[] = [{ priority: 3 }, { priority: 2 }, { priority: 1 }];
		const row = [["esc close", "enter open", "e export"]];
		const joined = fitRows(row, help, 40, { gap: " · " });
		assert.deepStrictEqual(plain(joined.lines), ["esc close · enter open · e export"]);
		const tight = fitRows(row, help, 25, { gap: " · " });
		assert.deepStrictEqual(plain(tight.lines), ["esc close · enter open"]);
		const tiny = fitRows(row, help, 6);
		assert.ok(visibleWidth(tiny.lines[0]) <= 6);
		assert.strictEqual(fitRows(row, help, 0).lines[0], "");
	});
});
