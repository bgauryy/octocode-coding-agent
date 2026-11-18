import assert from "node:assert";
import { describe, it } from "node:test";
import { Lines } from "../src/components/lines.ts";

const row = { lead: "⎿  ", text: "Done", meta: [" · general-0001", " · 14 tool calls"] };

describe("Lines row meta", () => {
	it("drops trailing meta parts whole, the last first, before the text is cut", () => {
		const lines = new Lines().set(undefined, [row]);
		assert.deepStrictEqual(lines.render(80), ["⎿  Done · general-0001 · 14 tool calls"]);
		// Exactly as wide as the whole row: everything stays.
		assert.deepStrictEqual(lines.render(38), ["⎿  Done · general-0001 · 14 tool calls"]);
		assert.deepStrictEqual(lines.render(37), ["⎿  Done · general-0001"]);
		assert.deepStrictEqual(lines.render(21), ["⎿  Done"]);
		// The cut itself closes styles; only the visible text is pinned.
		assert.deepStrictEqual(
			lines.render(5).map((line) => line.replace(/\x1b\[[\d;]*m/g, "")),
			["⎿  D…"],
		);
	});

	it("redraws when only the meta changes", () => {
		const lines = new Lines().set(undefined, [row]);
		assert.deepStrictEqual(lines.render(80), ["⎿  Done · general-0001 · 14 tool calls"]);
		lines.set(undefined, [{ ...row, meta: [" · general-0001", " · 15 tool calls"] }]);
		assert.deepStrictEqual(lines.render(80), ["⎿  Done · general-0001 · 15 tool calls"]);
	});

	it("ignores meta on a wrapping row and draws a row without meta as before", () => {
		const lines = new Lines().set(undefined, [{ text: "plain row" }, { ...row, wrap: true }]);
		assert.deepStrictEqual(lines.render(20), ["plain row", "⎿  Done"]);
	});
});
