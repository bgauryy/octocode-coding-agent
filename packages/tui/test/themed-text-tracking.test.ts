import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { ThemedText } from "../src/components/themed-text.ts";
import { Container } from "../src/tui.ts";

describe("ThemedText in a transcript", () => {
	it("is not drawn again while quiet, and is after invalidate or a width change", () => {
		const original = Text.prototype.render;
		let draws = 0;
		Text.prototype.render = function (this: Text, width: number) {
			draws++;
			return original.call(this, width);
		};
		try {
			let tone = "a";
			const text = new ThemedText(() => `notice ${tone}`, 0, 0);
			const parent = new Container();
			parent.addChild(text);
			assert.deepEqual(
				parent.render(40).map((row) => row.trimEnd()),
				["notice a"],
			);
			// Building the text in the first render signals once, so the frame after it draws again.
			parent.render(40);
			const first = draws;
			parent.render(40);
			parent.render(40);
			assert.equal(draws, first, "a quiet ThemedText is skipped");
			tone = "b";
			text.invalidate();
			assert.deepEqual(
				parent.render(40).map((row) => row.trimEnd()),
				["notice b"],
			);
			const afterInvalidate = draws;
			assert.ok(afterInvalidate > first);
			parent.render(30);
			assert.ok(draws > afterInvalidate, "a width change draws it again");
		} finally {
			Text.prototype.render = original;
		}
	});
});
