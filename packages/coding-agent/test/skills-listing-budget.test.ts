import { describe, expect, it } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import {
	skillListingBudgetChars,
	skillListingBudgetWarning,
	skillListingChars,
} from "../src/core/skills/listing-budget.ts";
import { SkillListing } from "../src/core/skills/listing.ts";
import { SKILL_SUMMARY_CHARS, skillSummary } from "../src/core/skills/summary.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function skill(name: string, description: string, disableModelInvocation = false): Skill {
	const filePath = `/skills/${name}/SKILL.md`;
	return {
		name,
		description,
		filePath,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation,
	};
}

const long = (n: number) => skill(`long-${n}`, `Use when ${"xxx ".repeat(300)}${n}`);

describe("skill listing budget", () => {
	it("budgets 1% of the window at the model family's chars per token, 200k tokens when unknown", () => {
		// Without a model: the densest family measured (Claude, 2.5 characters per token).
		expect(skillListingBudgetChars(200_000)).toBe(5_000);
		expect(skillListingBudgetChars(1_000_000)).toBe(25_000);
		expect(skillListingBudgetChars(undefined)).toBe(5_000);
		expect(skillListingBudgetChars(0)).toBe(5_000);
		expect(skillListingBudgetChars(200_000, { id: "claude-opus-5-5" })).toBe(5_000);
		expect(skillListingBudgetChars(200_000, { id: "gpt-6.1-sol" })).toBe(7_000);
	});

	it("warns once with count, size, budget and remedies when over budget", () => {
		const skills = [...Array.from({ length: 40 }, (_, i) => long(i)), skill("hidden", "h".repeat(5000), true)];
		const warning = skillListingBudgetWarning({ skills, contextWindow: 200_000 });
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain(`${skillListingChars(skills)} chars, budget 5000`);
		expect(warning?.message).toContain("octocode context check");
		expect(warning?.message).toContain("/harness");
	});

	it("uses the model's window: the same listing fits a larger window", () => {
		const skills = Array.from({ length: 40 }, (_, i) => long(i));
		expect(skillListingBudgetWarning({ skills, contextWindow: 1_000_000 })).toBeUndefined();
		expect(skillListingBudgetWarning({ skills, contextWindow: 100_000 })?.message).toContain("budget 2500");
	});

	it("is silent under budget", () => {
		const skills = [skill("a", "Does a."), skill("b", "Does b.")];
		expect(skillListingBudgetWarning({ skills })).toBeUndefined();
	});

	it("lists every enabled skill with a bounded summary and leaves the listing unchanged by the warning", () => {
		const skills = Array.from({ length: 40 }, (_, i) => long(i));
		const before = SkillListing.fromSkills(skills).render();
		const warning = skillListingBudgetWarning({ skills });
		const after = SkillListing.fromSkills(skills).render();
		expect(warning).toBeDefined();
		expect(after).toBe(before);
		for (const s of skills) expect(after).toContain(`${s.name}/SKILL.md: Use when xxx`);
		for (const line of after.split("\n")) expect(line.length).toBeLessThan(SKILL_SUMMARY_CHARS + 60);
	});

	it("summarizes a description to its first sentence, cut at a clause break outside parentheses", () => {
		expect(skillSummary("Load this skill first when asked to do x. Then y.")).toBe("Use when asked to do x");
		expect(
			skillSummary(
				"Use to a, b (c, d), e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, aa, bb, cc, dd, ee",
			),
		).not.toMatch(/\([^)]*$/);
		expect(skillSummary("Short one.")).toBe("Short one.");
		// A conjunction after a closed parenthesis is a clause break: the line never ends mid-clause.
		expect(
			skillSummary(
				"Use to file, update, split, close or groom backlog items (what an item needs, research plans, follow-ups) or run a sprint review: close done items.",
			),
		).toBe("Use to file, update, split, close or groom backlog items (what an item needs, research plans, follow-ups)");
		// No balanced clause break in the second half: cut before the open parenthesis, not inside it.
		expect(
			skillSummary(
				"Use when the user asks for maintenance or a health sweep (dependencies, dead code, stale docs, lint drift, flaky tests, retention, worktrees, caches).",
			),
		).toBe("Use when the user asks for maintenance or a health sweep");
	});

	it("counts only the skills a model may load", () => {
		const skills = [skill("a", "Does a."), skill("hidden", "h".repeat(5000), true)];
		expect(skillListingChars(skills)).toBe(SkillListing.fromSkills([skills[0]]).render().length);
		expect(skillListingChars([])).toBe(0);
	});
});
