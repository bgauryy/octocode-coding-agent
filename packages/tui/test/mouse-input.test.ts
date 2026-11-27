import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSgrMouseEvent, parseWheelEvent } from "../src/tui-alt-screen/mouse-input.ts";

describe("SGR mouse decoding", () => {
	it("reads a press, drag and release as button events", () => {
		assert.deepEqual(parseSgrMouseEvent("\x1b[<0;5;6M"), { button: 0, x: 4, y: 5, release: false });
		assert.equal(parseSgrMouseEvent("\x1b[<32;5;6M")?.button, 32);
		assert.equal(parseSgrMouseEvent("\x1b[<0;5;6m")?.release, true);
	});

	it("reads no wheel code, vertical or horizontal, as a button", () => {
		for (const code of [64, 65, 66, 67]) assert.equal(parseSgrMouseEvent(`\x1b[<${code};5;5M`), undefined, `${code}`);
	});

	it("reads only vertical wheel codes as wheel events", () => {
		assert.equal(parseWheelEvent("\x1b[<64;5;5M")?.direction, -1);
		assert.equal(parseWheelEvent("\x1b[<65;5;5M")?.direction, 1);
		assert.equal(parseWheelEvent("\x1b[<66;5;5M"), undefined);
	});
});
