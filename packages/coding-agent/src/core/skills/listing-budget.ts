import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { Skill } from "./identity.ts";

/** Context window assumed when the model's is unknown, in tokens. */
const DEFAULT_LISTING_CONTEXT_WINDOW = 200_000;
const CHARS_PER_TOKEN = 4;
/** The skill listing may take this share of the context window before the user is told. */
const LISTING_BUDGET_SHARE = 0.01;

/** The listing's character budget: 1% of the window at four characters per token (8,000 on 200k). */
export function skillListingBudgetChars(contextWindow?: number): number {
	const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_LISTING_CONTEXT_WINDOW;
	return Math.floor(window * CHARS_PER_TOKEN * LISTING_BUDGET_SHARE);
}

/** The `<available_skills>` block of a rendered system prompt: the listing the model reads. Undefined without one. */
export function skillListingOf(systemPrompt: string): string | undefined {
	return /^<available_skills>$[\s\S]*?^<\/available_skills>$/m.exec(systemPrompt)?.[0];
}

/**
 * A warning when the rendered skill `listing` is over budget, else undefined. The listing is never shortened: this only
 * tells the user, through the resource-diagnostic channel, so the prompt is the same with or without it.
 */
export function skillListingBudgetWarning(input: {
	skills: readonly Skill[];
	/** The text `formatSkillsForPrompt` rendered for these skills. */
	listing: string;
	contextWindow?: number;
}): ResourceDiagnostic | undefined {
	const budget = skillListingBudgetChars(input.contextWindow);
	const chars = input.listing.length;
	if (chars <= budget) return undefined;
	const count = input.skills.filter((skill) => !skill.disableModelInvocation).length;
	const noun = count === 1 ? "skill" : "skills";
	return {
		type: "warning",
		message: `Skill listing over budget: ${count} ${noun}, ${chars} chars > ${budget} budget (1% of the context window). Nothing is cut. Rewrite long descriptions with \`octocode context check\` and \`octocode context apply\`, or switch skills or whole harnesses off in /harness.`,
	};
}
