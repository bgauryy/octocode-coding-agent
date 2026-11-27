import assert from "node:assert";
import { describe, it } from "node:test";
import { fitRows, type RowColumn, WRAP_MARK } from "../src/components/row-fit.ts";
import { padToWidth } from "../src/utils/truncate.ts";
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

describe("fitRows overflow wrap", () => {
	const wrapColumns: RowColumn[] = [{ priority: 3 }, { priority: 2, flex: true, overflow: "wrap" }, { priority: 1 }];
	const long =
		"Bundle the model catalog into the installer so a first run works offline and never waits on the network";
	const gridRows = [
		["B2", long, "3 tasks"],
		["B10", "Short title", "#docs"],
	];

	for (const width of [80, 120, 200]) {
		it(`continues a long cell on ↳ lines at ${width} columns, keeping every word and the width`, () => {
			const { lines, lineRows } = fitRows(gridRows, wrapColumns, width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			assert.strictEqual(lines.length, lineRows.length);
			const [first, ...rest] = plain(lines.filter((_, i) => lineRows[i] === 0));
			const column = first.indexOf("Bundle");
			const continued = rest.map((line) => {
				assert.strictEqual(line.indexOf(WRAP_MARK), column, `↳ starts at the column: ${line}`);
				return line.slice(column + WRAP_MARK.length);
			});
			assert.ok(!first.includes("…"), "a wrap column never cuts");
			const text = [first.slice(column, first.indexOf("3 tasks")).trim(), ...continued].join(" ");
			assert.strictEqual(text.replace(/\s+/g, " "), long);
			if (width >= 120) assert.strictEqual(rest.length, 0, "no continuation when the cell fits");
			else assert.ok(rest.length > 0, "the cell continues");
			assert.deepStrictEqual(lineRows.at(-1), 1, "the next row follows its continuation lines");
			assert.ok(first.endsWith("3 tasks"), "later columns stay on the first line");
		});
	}

	it("wraps wide characters and ANSI without splitting or overflowing", () => {
		const cjk = [["B6", "\x1b[31m修复登录页面在中文环境下的超时问题 🔐 timeout and retry\x1b[0m", "#ui"]];
		// From 20 columns: below it the tag column is dropped (the flex column keeps its 12-cell floor).
		for (let width = 20; width <= 60; width++) {
			const { lines } = fitRows(cjk, wrapColumns, width);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
				assert.ok(!line.includes("\ufffd"));
			}
			const [first, ...rest] = plain(lines);
			assert.ok(first.endsWith(" #ui"), `${width}: the tag stays on the first line`);
			const text = [first.slice(3, -" #ui".length), ...rest].join("").replace(/[\s↳]/g, "");
			assert.strictEqual(text, "修复登录页面在中文环境下的超时问题🔐timeoutandretry", `${width}: every character kept`);
			const styledFirst = lines[0].slice(0, lines[0].lastIndexOf(" #ui")).trimEnd();
			if (rest.length > 0) assert.ok(styledFirst.endsWith("\x1b[0m"), `${width}: the red ends before #ui`);
		}
	});

	it("keeps an exact fit on one line", () => {
		const exact = [["B1", "abcdefghij", "x"]];
		const { lines } = fitRows(exact, wrapColumns, "B1 abcdefghij x".length);
		assert.deepStrictEqual(plain(lines), ["B1 abcdefghij x"]);
	});

	it("wraps a capped non-flex column instead of cutting it", () => {
		const capped: RowColumn[] = [
			{ priority: 2, max: 10, overflow: "wrap" },
			{ priority: 1, flex: true },
		];
		const { lines } = fitRows([["packages/tui/src", "title"]], capped, 40);
		assert.deepStrictEqual(
			plain(lines).map((line) => line.trimEnd()),
			["packages/t title", "↳ ui/src"],
		);
	});
});

describe("padToWidth", () => {
	it("pads by terminal columns, ignoring ANSI, on either side", () => {
		assert.strictEqual(padToWidth("ab", 4), "ab  ");
		assert.strictEqual(padToWidth("ab", 4, "right"), "  ab");
		assert.strictEqual(padToWidth("漢字", 6), "漢字  ");
		assert.strictEqual(padToWidth("\x1b[31mab\x1b[0m", 3), "\x1b[31mab\x1b[0m ");
		assert.strictEqual(visibleWidth(padToWidth("🔐x", 5)), 5);
	});

	it("returns an exact fit or wider text unchanged", () => {
		assert.strictEqual(padToWidth("abcd", 4), "abcd");
		assert.strictEqual(padToWidth("abcdef", 4), "abcdef");
		assert.strictEqual(padToWidth("", 0), "");
	});
});
