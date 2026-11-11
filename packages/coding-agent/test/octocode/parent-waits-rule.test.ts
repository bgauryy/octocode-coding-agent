import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getInstructionsDir } from "../../src/config.ts";
import { instructionSource, renderInstruction } from "../../src/core/prompt-template.ts";

/**
 * "Your coordinator reads messages only with your report" is one rule with one owner, `shared/parent-waits.md`: the
 * result of a foreground child's message to its parent (`team/tools/messages.ts`), the check-in and the budget notice
 * all render that file, so they cannot drift into different wordings.
 */
describe("the parent-waits rule", () => {
	const rule = renderInstruction("shared/parent-waits.md");

	it("has no second copy under the mail notices", () => {
		expect(() => instructionSource("notices/mail/parent-waits.md")).toThrow(/no file notices\/mail\/parent-waits\.md/);
		expect(rule).toBe(
			"Your coordinator waits for your report and reads messages only with it, so it cannot answer during this run; if you need its decision or it should know now, finish with a `blocked` report that says so.",
		);
	});

	it("is what the message tool, the check-in and the budget notice say", () => {
		const messages = fs.readFileSync(path.join(getInstructionsDir(), "..", "team", "tools", "messages.ts"), "utf8");
		expect(messages).toContain('renderInstruction("shared/parent-waits.md")');
		expect(messages).not.toContain("notices/mail/parent-waits.md");
		for (const notice of ["notices/subagents/check-in.md", "notices/subagents/budget-steer.md"])
			expect(instructionSource(notice), notice).toContain("{{> shared/parent-waits.md}}");
	});
});
