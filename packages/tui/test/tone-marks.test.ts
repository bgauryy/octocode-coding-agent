import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { GLYPH, setEmojiMarks, TONE, titleMark } from "../src/tokens/design.ts";

const cells = (text: string) => [...text].length;

describe("tone marks", () => {
	afterEach(() => setEmojiMarks(false));

	it("default to width-safe glyphs that no state mark shares", () => {
		const marks = [TONE.calm, TONE.caution, TONE.problem, titleMark()];
		for (const mark of marks) {
			assert.strictEqual(cells(mark), 1, mark);
			assert.doesNotMatch(mark, /\p{Extended_Pictographic}\uFE0F?/u, mark);
			assert.ok(!Object.values(GLYPH).includes(mark), `${mark} is a state mark`);
		}
		assert.strictEqual(new Set(marks).size, marks.length);
	});

	it("switch to the sea emoji and back with setEmojiMarks", () => {
		setEmojiMarks(true);
		assert.deepStrictEqual([TONE.calm, TONE.caution, TONE.problem, titleMark()], ["🐚", "🦀", "🦈", "🦑"]);
		setEmojiMarks(false);
		assert.notStrictEqual(TONE.calm, "🐚");
		assert.notStrictEqual(titleMark(), "🦑");
	});
});
