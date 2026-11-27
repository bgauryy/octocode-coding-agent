import { describe, expect, it } from "vitest";
import { firstToolCallDifference, type ToolCallStages } from "../src/tool-call-replay.ts";

describe("first differing tool-call boundary", () => {
	const expected = { depth: 3, path: "." };
	const control: ToolCallStages = {
		rawDeltas: ['{"path":".","de', 'pth":3}'],
		assistant: expected,
		beforeValidation: expected,
		validation: { accepted: true, arguments: expected },
		serverCalls: [expected],
	};
	it.each<[Partial<ToolCallStages>, string]>([
		[{}, "none"],
		[{ rawDeltas: ['{"depthValue":3}'] }, "provider-deltas"],
		[{ rawDeltas: ["{"] }, "provider-deltas"],
		[{ assistant: {} }, "parsed-assistant"],
		[{ rawDeltas: undefined, assistant: {} }, "unknown"],
		[{ rawDeltas: [], assistant: {} }, "unknown"],
		[{ beforeValidation: {} }, "host-preparation"],
		[{ validation: { accepted: false, error: "rejected" } }, "validation"],
		[{ validation: { accepted: true, arguments: {} } }, "validation"],
		[{ serverCalls: [] }, "server-received"],
		[{ serverCalls: [expected, expected] }, "server-received"],
	])("attributes %j to %s", (changes, stage) => {
		expect(firstToolCallDifference(expected, { ...control, ...changes })).toBe(stage);
	});
});
