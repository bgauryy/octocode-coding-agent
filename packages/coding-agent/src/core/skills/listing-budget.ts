import { charsPerToken } from "@octocodeai/octocode-ai/utils/estimate";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { Skill } from "./identity.ts";
import { SkillListing } from "./listing.ts";

/** Context window assumed when the model's is unknown, in tokens. */
const DEFAULT_LISTING_CONTEXT_WINDOW = 200_000;
/** The skill listing may take this share of the context window before the user is told. */
const LISTING_BUDGET_SHARE = 0.01;

/**
 * The listing's character budget: 1% of the window, in characters at the model family's measured ratio
 * (`charsPerToken`; without a model, the densest family's 2.5, so 5,000 on 200k).
 */
export function skillListingBudgetChars(contextWindow?: number, model?: { id: string }): number {
	const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_LISTING_CONTEXT_WINDOW;
	return Math.floor(window * charsPerToken(model) * LISTING_BUDGET_SHARE);
}

/** The characters the `skill` tool's description spends on these skills: the listing a model reads, as the tool renders it. */
export function skillListingChars(skills: readonly Skill[]): number {
	return SkillListing.fromSkills(skills).render().length;
}

/**
 * A warning when the skill listing of `skills` is over budget, else undefined. The listing is never shortened: this only
 * tells the user, through the resource-diagnostic channel, so the tool's description is the same with or without it.
 */
export function skillListingBudgetWarning(input: {
	skills: readonly Skill[];
	contextWindow?: number;
	/** The session's model, for its characters per token. */
	model?: { id: string };
}): ResourceDiagnostic | undefined {
	const budget = skillListingBudgetChars(input.contextWindow, input.model);
	const chars = skillListingChars(input.skills);
	if (chars <= budget) return undefined;
	return {
		type: "warning",
		message: `Skill list too long: ${chars} chars, budget ${budget} · fix: octocode context check/apply, or /harness`,
	};
}
