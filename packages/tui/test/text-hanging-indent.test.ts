import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

describe("Text hanging indent", () => {
	it("wraps continuation rows to column 0 by default", () => {
		const text = new Text("  alpha, beta, gamma, delta", 0, 0);
		assert.deepStrictEqual(plain(text.render(16)), ["  alpha, beta,", "gamma, delta"]);
	});

	it("keeps the line's leading spaces on continuation rows when enabled", () => {
		const text = new Text("[Skills]\n\x1b[2m  alpha, beta, gamma, delta, epsilon\x1b[22m", 0, 0);
		text.setHangingIndent(true);
		assert.deepStrictEqual(plain(text.render(16)), ["[Skills]", "  alpha, beta,", "  gamma, delta,", "  epsilon"]);
	});
});
