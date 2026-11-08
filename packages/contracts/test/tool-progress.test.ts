import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { ApplicationToolSchema, toolProgressFraction, toolProgressText } from "../src/index.ts";

it("formats a tool's progress the same way for every surface", () => {
	expect(toolProgressText({ progress: 3, total: 10, message: "Indexing" })).toBe("3/10 (30%) · Indexing");
	expect(toolProgressText({ progress: 3 })).toBe("3");
	expect(toolProgressText({ progress: 12, total: 10 })).toBe("12/10 (100%)");
	expect(toolProgressFraction({ progress: 1, total: 0 })).toBeUndefined();
	expect(toolProgressFraction({ progress: 1, total: 4 })).toBe(0.25);
});

it("accepts progress on a tool and rejects a negative count", () => {
	const tool = { toolCallId: "t", toolName: "x", text: "", status: "running" };
	expect(Value.Check(ApplicationToolSchema, { ...tool, progress: { progress: 1, total: 2 } })).toBe(true);
	expect(Value.Check(ApplicationToolSchema, { ...tool, progress: { progress: -1 } })).toBe(false);
});
