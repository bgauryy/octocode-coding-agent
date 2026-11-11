import assert from "node:assert";
import { describe, it } from "node:test";
import { CURSOR_MARKER, extractCursorPosition, renderFakeCursor, resolveFakeCursors } from "../src/tui/cursor.ts";
import { CursorRows } from "../src/tui-main-screen/cursor-rows.ts";
import {
	carryKittyImageRows,
	collectKittyImageIds,
	deleteChangedKittyImages,
	findKittyImageRows,
	KittyImageRowCache,
} from "../src/tui-main-screen/kitty-images.ts";
import { findChangedLineRange } from "../src/tui-main-screen/render-diff.ts";

const kittyRow = (id: number, rows = 1) => `\x1b_Ga=p,i=${id},r=${rows};\x1b\\`;

/** A seeded sequence of frames: rows change, appear and disappear the way a transcript and editor do. */
function frames(count: number, seed: number): string[][] {
	let state = seed;
	const random = () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
	const row = (index: number): string => {
		const pick = random();
		if (pick < 0.08) return kittyRow(1 + Math.floor(random() * 5), 1 + Math.floor(random() * 3));
		if (pick < 0.12) return "";
		if (pick < 0.2) return `edit ${index}${CURSOR_MARKER}${renderFakeCursor("x")} tail${CURSOR_MARKER}`;
		if (pick < 0.25) return `blurred ${renderFakeCursor(" ")}`;
		return `row ${index} \x1b[1m${Math.floor(random() * 3)}\x1b[0m`;
	};
	const result: string[][] = [];
	let lines = Array.from({ length: 30 }, (_, index) => row(index));
	for (let frame = 0; frame < count; frame++) {
		lines = lines.slice();
		const edits = Math.floor(random() * 4);
		for (let edit = 0; edit < edits; edit++) {
			const at = Math.floor(random() * lines.length);
			lines[at] = row(at);
		}
		if (random() < 0.3) lines.push(row(lines.length));
		if (random() < 0.15) lines.splice(Math.floor(random() * lines.length), 1);
		result.push(lines);
	}
	return result;
}

describe("main-screen row memories", () => {
	it("resolve cursors exactly as a whole-frame pass, frame after frame", () => {
		const memo = new CursorRows();
		for (const [index, lines] of frames(200, 7).entries()) {
			const showHardwareCursor = index % 50 < 25;
			const height = 5 + (index % 20);
			const expected = resolveFakeCursors(lines, showHardwareCursor);
			const expectedCursor = extractCursorPosition(expected, height);
			const actual = memo.resolve(lines, showHardwareCursor, height);
			assert.deepStrictEqual(actual.lines, expected, `frame ${index}`);
			assert.deepStrictEqual(actual.cursor, expectedCursor, `frame ${index}`);
		}
	});

	it("extract the cursor after compositing overlays", () => {
		const memo = new CursorRows();
		const lines = ["a", `b${CURSOR_MARKER}`, "c"];
		const overlay = (resolved: string[]) => [...resolved.slice(0, 2), `ov${CURSOR_MARKER}erlay`];
		assert.deepStrictEqual(memo.resolve(lines, false, 3, overlay), {
			lines: ["a", "b", "overlay"],
			cursor: { row: 2, col: 2 },
		});
	});

	it("carry Kitty image rows exactly as a full scan finds them", () => {
		const cache = new KittyImageRowCache();
		let previous: string[] = [];
		for (const [index, lines] of frames(300, 11).entries()) {
			assert.deepStrictEqual([...cache.of(previous)], [...findKittyImageRows(previous)], `previous ${index}`);
			const rows = cache.of(lines);
			assert.deepStrictEqual([...rows], [...findKittyImageRows(lines)], `frame ${index}`);
			const imageRows = { previous: cache.of(previous), next: rows };
			const range = findChangedLineRange(previous, lines);
			assert.deepStrictEqual(findChangedLineRange(previous, lines, 0, imageRows), range, `range ${index}`);
			assert.deepStrictEqual(
				findChangedLineRange(previous, lines, 10, imageRows),
				findChangedLineRange(previous, lines, 10),
			);
			assert.deepStrictEqual([...collectKittyImageIds(lines, rows)], [...collectKittyImageIds(lines)]);
			assert.strictEqual(
				deleteChangedKittyImages(previous, range.firstChanged, range.lastChanged, imageRows.previous),
				deleteChangedKittyImages(previous, range.firstChanged, range.lastChanged),
			);
			previous = lines;
		}
	});

	it("carry rows across a frame that shrinks, grows and differs at both ends", () => {
		const known = [kittyRow(1), "a", kittyRow(2, 2), "", "b", kittyRow(3)];
		const lines = ["x", "a", kittyRow(2, 2), "", kittyRow(4), "c", kittyRow(5)];
		assert.deepStrictEqual(
			[...carryKittyImageRows(known, findKittyImageRows(known), lines)],
			[...findKittyImageRows(lines)],
		);
		const shorter = known.slice(0, 3);
		assert.deepStrictEqual(
			[...carryKittyImageRows(lines, findKittyImageRows(lines), shorter)],
			[
				[0, [1]],
				[2, [2]],
			],
		);
	});
});
