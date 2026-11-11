import assert from "node:assert/strict";
import { it } from "node:test";
import { EditorWrapCache } from "../src/components/editor/wrap-cache.ts";
import { graphemeSegmenter, segmentWithMarkers } from "../src/components/editor/segmentation.ts";
import { wordWrapLine } from "../src/components/editor/word-wrap.ts";

it("reuses wrapping across renders and cursor moves, and wraps only an edited line", () => {
	const cache = new EditorWrapCache();
	const lines = ["some long text repeated here", "another long line to wrap"];
	const segmented: string[] = [];
	const segment = (text: string) => {
		segmented.push(text);
		return [...graphemeSegmenter.segment(text)];
	};
	const wrap = () => cache.forLines(lines, 10, [], segment);
	const first = lines.map(wrap());
	assert.deepEqual(segmented, lines);
	const next = lines.map(wrap());
	assert.equal(next[0], first[0]);
	assert.equal(next[1], first[1]);
	assert.equal(segmented.length, 2);
	lines[1] += " changed";
	const changed = lines.map(wrap());
	assert.equal(changed[0], first[0]);
	assert.deepEqual(changed[1], wordWrapLine(lines[1], 10));
	assert.equal(segmented.length, 3);
});

it("invalidates wrapping on resize and when valid paste IDs change without changing their count", () => {
	const cache = new EditorWrapCache();
	const line = "before [paste #1 1234 chars] after";
	const lines = [line];
	const wrap = (width: number, ids: number[]) =>
		cache.forLines(lines, width, ids, (text) => [...segmentWithMarkers(text, graphemeSegmenter, new Set(ids))])(
			line,
			0,
		);
	const first = wrap(20, [1]);
	const plain = wrap(20, [2]);
	assert.notDeepEqual(first, plain);
	assert.deepEqual(plain, wordWrapLine(line, 20));
	assert.deepEqual(wrap(12, [2]), wordWrapLine(line, 12));
	assert.deepEqual(wrap(20, [1]), first);
});

it("releases removed draft lines and handles an in-place insertion or replacement", () => {
	const cache = new EditorWrapCache();
	const lines = ["first long line", "second long line"];
	const wrap = () => cache.forLines(lines, 8, [], (line) => [...graphemeSegmenter.segment(line)]);
	lines.map(wrap());
	lines.splice(0, 1);
	assert.deepEqual(
		lines.map(wrap()),
		lines.map((line) => wordWrapLine(line, 8)),
	);
	lines.splice(0, 1, "replacement", "third long line");
	assert.deepEqual(
		lines.map(wrap()),
		lines.map((line) => wordWrapLine(line, 8)),
	);
});
