import assert from "node:assert";
import { describe, it } from "node:test";
import { StreamingText } from "../src/components/markdown/streaming-text.ts";
import { getSelectionText } from "../src/tui-alt-screen/selection.ts";
import { withSoftWrapMarks } from "../src/utils/row-marks.ts";
import { visibleWidth } from "../src/utils/width.ts";

const SOURCE = [
	"## Plan with **bold** and `code`",
	"",
	"- a list item that is long enough to wrap at the narrow width",
	"\tindented with a tab",
	"全角の文字が続く行です。折り返しを確認します。全角の文字が続く行です。",
	"See https://example.com/a/very/long/path/without/any/spaces/that/must/break/somewhere",
	"```ts",
	"const value = compute(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);",
	"```",
	"",
	"[docs]: https://example.com/docs",
].join("\n");

function fresh(text: string, width: number): string[] {
	return new StreamingText(text, 1).render(width);
}

describe("StreamingText", () => {
	it("shows the source as plain text, every row within the width", () => {
		for (const width of [12, 20, 41]) {
			const rows = fresh(SOURCE, width);
			for (const row of rows) assert.strictEqual(visibleWidth(row), width, JSON.stringify(row));
			const text = rows.join("");
			assert.ok(!text.includes("\t"));
			assert.ok(text.includes("[docs]:"));
		}
		assert.ok(fresh(SOURCE, 80).some((row) => row.includes("## Plan with **bold** and `code`")));
	});

	it("renders every prefix of a stream as a fresh component does, across width changes", () => {
		const streamed = new StreamingText("", 1);
		const widths = [20, 20, 33, 7, 20];
		for (let end = 0; end <= SOURCE.length; end++) {
			const width = widths[end % widths.length];
			const text = SOURCE.slice(0, end);
			streamed.setText(text);
			assert.deepStrictEqual(streamed.render(width), fresh(text, width), `prefix ${end} at ${width}`);
		}
	});

	it("wraps afresh when the text is replaced rather than extended", () => {
		const streamed = new StreamingText(SOURCE, 1);
		streamed.render(30);
		for (const text of [SOURCE.replace("Plan", "Other"), SOURCE.slice(0, 40), "", "short"]) {
			streamed.setText(text);
			assert.deepStrictEqual(streamed.render(30), fresh(text, 30), JSON.stringify(text));
		}
	});

	it("styles each line and wraps what a transform returns", () => {
		const rows = new StreamingText(
			"one\ntwo",
			0,
			(line) => `\x1b[3m${line}\x1b[23m`,
			(text) => text.toUpperCase(),
		).render(10);
		assert.deepStrictEqual(
			rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()),
			["ONE", "TWO"],
		);
		assert.ok(rows.every((row) => row.includes("\x1b[3m")));
	});

	it("copies wrapped rows back as the source lines", () => {
		const line = "- a list item that is long enough to wrap at the narrow width";
		const streamed = new StreamingText("", 1);
		streamed.setText(`${line}\n`);
		streamed.render(20);
		streamed.setText(`${line}\nnext`);
		// Scroll-view content renders with soft-wrap marks; rows settled without them are wrapped again.
		const rows = withSoftWrapMarks(() => streamed.render(20));
		assert.deepStrictEqual(
			rows,
			withSoftWrapMarks(() => fresh(`${line}\nnext`, 20)),
		);
		assert.ok(rows.length > 3);
		const copied = getSelectionText(
			{ start: { row: 0, col: 0 }, end: { row: rows.length - 1, col: 20 } },
			rows,
			undefined,
		);
		assert.strictEqual(copied, `${line}\nnext`);
	});
});
