import { describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { leanPromptSections } from "../../src/octocode/native/prompts/lean.ts";
import { octocodePromptSections } from "../../src/octocode/native/prompts/policy.ts";

/** What tells an agent to lock the files it edits (policy/change.md). */
const LOCKS = /\block (?:your paths|it with `agent`|any other file)/;

const policy = (canDelegate: boolean, readOnly: boolean, canUseAgent = true) =>
	Object.values(octocodePromptSections({ profiles: [], canDelegate, readOnly, canUseAgent })).join("\n");

describe("coordination guidance", () => {
	it("keeps the tool's own guideline free of lock guidance, so every role shares one cached base block", () => {
		expect(renderPrompt("tools/coordinate/guidelines.md")).not.toMatch(LOCKS);
	});

	it("tells the main session and a writable subagent to lock the files they edit", () => {
		expect(policy(true, false)).toMatch(LOCKS);
		expect(policy(false, false)).toMatch(LOCKS);
		expect(leanPromptSections({ canShell: true, canSave: true, readOnly: false }).lean).toMatch(LOCKS);
	});

	it("tells a read-only subagent nothing about locking, lean or not", () => {
		expect(policy(false, true)).not.toMatch(LOCKS);
		expect(leanPromptSections({ canShell: true, canSave: false, readOnly: true }).lean).not.toMatch(LOCKS);
	});

	it("leaves the lock guidance out where the agent tool is not exposed", () => {
		expect(policy(false, false, false)).not.toMatch(LOCKS);
		expect(leanPromptSections({ canShell: true, canSave: true, readOnly: false, agentTool: false }).lean).not.toMatch(
			LOCKS,
		);
	});
});
