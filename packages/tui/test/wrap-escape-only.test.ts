import assert from "node:assert";
import { describe, it } from "node:test";
import { wrapTextWithAnsi } from "../src/utils/wrap.ts";
import { visibleWidth } from "../src/utils/width.ts";

const visible = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("wrapTextWithAnsi long word after a space", () => {
	it("emits no style-only line when a long word follows a space that filled the row", () => {
		// The 5-letter word fills the row, the space wraps (leaving only the active style), then the 12-letter word breaks.
		for (const text of ["\x1b[1maaaaa bbbbbbbbbbbb\x1b[22m", "\x1b[31maaaaa \x1b[39mbbbbbbbbbbbb"]) {
			const lines = wrapTextWithAnsi(text, 5);
			assert.ok(
				lines.every((line) => visible(line) !== ""),
				JSON.stringify(lines),
			);
			assert.ok(lines.every((line) => visibleWidth(line) <= 5));
			assert.strictEqual(lines.map(visible).join(""), "aaaaabbbbbbbbbbbb");
		}
	});

	it("keeps the active style on the pieces of the broken word", () => {
		const lines = wrapTextWithAnsi("\x1b[31maaaaa bbbbbbbbbbbb\x1b[39m", 5);
		assert.ok(
			lines.slice(1).every((line) => line.includes("\x1b[31m")),
			JSON.stringify(lines),
		);
	});
});
