import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "../src/core/skills.ts";
import {
	skillListingBudgetChars,
	skillListingBudgetWarning,
	skillListingOf,
} from "../src/core/skills/listing-budget.ts";
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

const long = (n: number) => skill(`long-${n}`, `Use when ${"x".repeat(900)} ${n}`);

describe("skill listing budget", () => {
	it("budgets 1% of the window at four chars per token, 200k tokens when unknown", () => {
		expect(skillListingBudgetChars(200_000)).toBe(8_000);
		expect(skillListingBudgetChars(1_000_000)).toBe(40_000);
		expect(skillListingBudgetChars(undefined)).toBe(8_000);
		expect(skillListingBudgetChars(0)).toBe(8_000);
	});

	it("warns once with count, size, budget and remedies when over budget", () => {
		const skills = [...Array.from({ length: 12 }, (_, i) => long(i)), skill("hidden", "h".repeat(5000), true)];
		const listing = formatSkillsForPrompt(skills, "skill").trim();
		const warning = skillListingBudgetWarning({ skills, listing, contextWindow: 200_000 });
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain(`12 skills, ${listing.length} chars > 8000 budget`);
		expect(warning?.message).toContain("octocode context check");
		expect(warning?.message).toContain("octocode context apply");
		expect(warning?.message).toContain("/skills");
	});

	it("uses the model's window: the same listing fits a larger window", () => {
		const skills = Array.from({ length: 12 }, (_, i) => long(i));
		const listing = formatSkillsForPrompt(skills, "skill").trim();
		expect(skillListingBudgetWarning({ skills, listing, contextWindow: 1_000_000 })).toBeUndefined();
		expect(skillListingBudgetWarning({ skills, listing, contextWindow: 100_000 })?.message).toContain("> 4000 budget");
	});

	it("is silent under budget", () => {
		const skills = [skill("a", "Does a."), skill("b", "Does b.")];
		const listing = formatSkillsForPrompt(skills, "skill").trim();
		expect(skillListingBudgetWarning({ skills, listing })).toBeUndefined();
	});

	it("leaves the model-facing listing byte-identical and whole", () => {
		const skills = Array.from({ length: 12 }, (_, i) => long(i));
		const before = formatSkillsForPrompt(skills, "skill");
		const warning = skillListingBudgetWarning({ skills, listing: before.trim() });
		const after = formatSkillsForPrompt(skills, "skill");
		expect(warning).toBeDefined();
		expect(after).toBe(before);
		for (const s of skills) expect(after).toContain(s.description);
	});

	it("measures the listing block of a system prompt, not a mention of its tag", () => {
		const listing = formatSkillsForPrompt([long(1)], "skill");
		const block = listing.slice(listing.indexOf("<available_skills>"));
		const prompt = `Load a skill listed in <available_skills>.\n${listing}\n\nMore rules.`;
		expect(skillListingOf(prompt)).toBe(block);
		expect(skillListingOf("no skills here")).toBeUndefined();
	});
});
