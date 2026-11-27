import assert from "node:assert/strict";
import { it } from "node:test";
import { getSelectionText } from "../src/tui-alt-screen/selection.ts";

it("copies complete interior rows with Unicode, ANSI styling and hyperlinks while retaining partial wide edges", () => {
	const lines = [
		"A界B",
		"\x1b[31m日本語 text\x1b[0m   ",
		"\x1b]8;;https://example.invalid/\x07linked 文\x1b]8;;\x07  ",
		"",
		"Z界Y",
	];
	assert.equal(
		getSelectionText({ start: { row: 0, col: 2 }, end: { row: 4, col: 1 } }, lines, undefined),
		"界B\n日本語 text\nlinked 文\n\nZ界",
	);
});

it("retains combined graphemes and excludes standalone trailing zero-width characters as before", () => {
	const lines = ["first", "e\u0301 👩‍💻 文", "text\u200b", "\u0301", "last"];
	assert.equal(
		getSelectionText({ start: { row: 0, col: 0 }, end: { row: 4, col: 3 } }, lines, undefined),
		"first\ne\u0301 👩‍💻 文\ntext\n\nlast",
	);
});

it("keeps inclusive and boundary column semantics for a selection on one row", () => {
	const start = { row: 0, col: 2 };
	assert.equal(getSelectionText({ start, end: { row: 0, col: 4 } }, ["ab界cd"], undefined), "界c");
	assert.equal(getSelectionText({ start, end: { row: 0, col: 4, boundary: true } }, ["ab界cd"], undefined), "界");
});
