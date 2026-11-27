import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "../src/components/text.ts";
import { findAltScreenSearchMatches } from "../src/tui-alt-screen/search-index.ts";
import { resolveFakeCursors } from "../src/tui/cursor.ts";
import { visibleWidth } from "../src/utils/width.ts";
import { wrapTextWithAnsi } from "../src/utils/wrap.ts";

function rows(match: { segments: { row: number; startCol: number; endCol: number }[] }) {
	return match.segments.map(({ row, startCol, endCol }) => [row, startCol, endCol]);
}

test("a token the width splits mid-word matches across both rows, highlighted on each", () => {
	const lines = wrapTextWithAnsi("see /usr/local/lib/node_modules ok", 17);
	assert.deepEqual(
		resolveFakeCursors(lines, false),
		["see", "/usr/local/lib/no", "de_modules ok"],
		"the marks never reach the screen",
	);
	const matches = findAltScreenSearchMatches(lines, "/usr/local/lib/node_modules");
	assert.equal(matches.length, 1);
	assert.deepEqual(rows(matches[0]), [
		[1, 0, 17],
		[2, 0, 10],
	]);
});

test("a split token inside a padded Text component matches with columns of the drawn rows", () => {
	const lines = new Text(`see ${"x".repeat(10)}/usr/local/lib/node_modules ok`, 1, 0).render(20);
	const matches = findAltScreenSearchMatches(lines, "/usr/local/lib");
	assert.equal(matches.length, 1);
	const screen = resolveFakeCursors(lines, false);
	for (const segment of matches[0].segments) {
		assert.ok(segment.endCol <= visibleWidth(screen[segment.row]));
	}
	assert.equal(matches[0].segments.length, 2);
});

test("a phrase word-wrapped at a space matches with the space", () => {
	const lines = wrapTextWithAnsi("alpha bravo charlie delta", 12);
	assert.deepEqual(lines, ["alpha bravo", "charlie", "delta"]);
	const matches = findAltScreenSearchMatches(lines, "bravo charlie delta");
	assert.equal(matches.length, 1);
	assert.deepEqual(rows(matches[0]), [
		[0, 6, 11],
		[1, 0, 7],
		[2, 0, 5],
	]);
	assert.equal(findAltScreenSearchMatches(lines, "bravocharlie").length, 0);
});

test("rows of separate source lines are never joined mid-word", () => {
	const lines = wrapTextWithAnsi("see /usr/local/li\nb/node_modules ok", 40);
	assert.deepEqual(lines, ["see /usr/local/li", "b/node_modules ok"]);
	assert.equal(findAltScreenSearchMatches(lines, "/usr/local/lib").length, 0);
	assert.equal(findAltScreenSearchMatches(lines, "local/li b/node").length, 1);
});

test("wide text the width breaks between characters matches without a space", () => {
	const lines = wrapTextWithAnsi("日本語の文章です", 8);
	assert.equal(lines.length, 2);
	const matches = findAltScreenSearchMatches(lines, "語の文章");
	assert.equal(matches.length, 1);
	assert.deepEqual(rows(matches[0]), [
		[0, 4, 8],
		[1, 0, 4],
	]);
});

test("a word cut at a hanging-indent row break still joins", () => {
	const text = new Text("  日本語の文章です日本語の文章です", 0, 0);
	text.setHangingIndent(true);
	const lines = text.render(12);
	assert.ok(lines[1]?.startsWith("  "), JSON.stringify(lines));
	const matches = findAltScreenSearchMatches(lines, "語の文章で");
	assert.equal(matches.length, 2, "the phrase occurs twice");
	assert.deepEqual(rows(matches[0]), [
		[0, 6, 12],
		[1, 2, 6],
	]);
});
