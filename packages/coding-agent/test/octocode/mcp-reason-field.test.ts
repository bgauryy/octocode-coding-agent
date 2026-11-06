import { describe, expect, it } from "vitest";
import { octocodePromptSections } from "../../src/octocode/instructions/policy.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

const SENTENCE = "`reason` is for this harness's own tools; MCP tools take only the fields their schema declares.";
const input = { research: FAKE_RESEARCH, canDelegate: true, profiles: [] };
const text = (value: Parameters<typeof octocodePromptSections>[0]) =>
	Object.values(octocodePromptSections(value)).join("\n");

describe("reason is not an MCP argument", () => {
	it("tells a main session and a read-only child that MCP tools take only their declared fields", () => {
		for (const prompt of [text(input), text({ ...input, readOnly: true, canDelegate: false })])
			expect(prompt).toContain(SENTENCE);
	});

	it("leaves the sentence out when no MCP tool is reachable", () => {
		expect(text({ ...input, canMcp: false })).not.toContain(SENTENCE);
		expect(text({ ...input, canMcp: false, readOnly: true, canDelegate: false })).not.toContain(SENTENCE);
	});
});
