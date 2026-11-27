import { expect, it } from "vitest";
import { knownToolDisplayBlock, parseApplicationFrame, toolDisplayText, type ToolDisplay } from "../src/index.ts";

const display: ToolDisplay = {
	title: "Bash",
	summary: "npm test",
	meta: ["background"],
	reason: "Run the tests",
	outcome: { text: "exit 0 · 2 lines" },
	blocks: [
		{ type: "output", text: "ok 1\nok 2", exitCode: 0 },
		{ type: "chart", text: "3 passed, 0 failed" },
	],
};

it("accepts a frame whose display holds a block type this version does not know, and shows its text", () => {
	const frame = parseApplicationFrame({
		protocolVersion: 1,
		cursor: { sessionId: "s", epoch: "e", sequence: 1 },
		at: 1,
		type: "event",
		event: { type: "tool.completed", toolCallId: "t", toolName: "bash", display },
	});
	expect(frame).toBeDefined();
	expect(knownToolDisplayBlock(display.blocks[0])?.type).toBe("output");
	expect(knownToolDisplayBlock(display.blocks[1])).toBeUndefined();
	expect(toolDisplayText(display)).toBe(
		"Bash(npm test) · background\n↳ Run the tests\n⎿ exit 0 · 2 lines\nok 1\nok 2\n3 passed, 0 failed",
	);
});

it("treats a known block type with a wrong shape as unknown, so a view never reads missing fields", () => {
	expect(knownToolDisplayBlock({ type: "diff", text: "a.ts +1" })).toBeUndefined();
});
