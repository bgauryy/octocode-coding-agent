import assert from "node:assert";
import { describe, it } from "node:test";
import { markPromptRows, Osc133ZoneMarker } from "../src/terminal/osc133-zone.ts";

const A = "\x1b]133;A\x07";
const B = "\x1b]133;B\x07";
const C = "\x1b]133;C\x07";
const D = "\x1b]133;D";

/** The shell state a terminal tracking OSC 133 ends in after reading `rows`: the last mark wins. */
function finalState(rows: string[]): "prompt" | "output" | "none" {
	const marks = [...rows.join("\n").matchAll(/\x1b\]133;([ABCD])/g)].map((match) => match[1]);
	const last = marks.at(-1);
	if (last === undefined) return "none";
	return last === "A" || last === "B" ? "prompt" : "output";
}

describe("prompt marks for an idle input editor", () => {
	it("a frame of messages ends in output state; the marked editor after it ends in prompt state", () => {
		const message = new Osc133ZoneMarker().mark(["assistant says hi"]);
		assert.strictEqual(finalState(message), "output");
		const frame = [...message, ...markPromptRows(["╭──╮", "│ > │", "╰──╯"]), "footer"];
		assert.strictEqual(finalState(frame), "prompt");
		assert.ok(frame.join("").lastIndexOf(A) > frame.join("").lastIndexOf(C), "the prompt starts after the last output");
		assert.ok(!frame.join("").includes(D), "no command-finished mark");
	});

	it("does not touch the input rows", () => {
		const rows = ["a", "b"];
		const marked = markPromptRows(rows);
		assert.deepStrictEqual(rows, ["a", "b"]);
		assert.strictEqual(marked[0], `${A}${B}a`);
		assert.strictEqual(marked[1], "b");
		assert.deepStrictEqual(markPromptRows([]), []);
	});
});
