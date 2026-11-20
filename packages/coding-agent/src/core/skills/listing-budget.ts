import { charsPerToken } from "@octocodeai/octocode-ai/utils/estimate";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { Skill } from "./identity.ts";

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
	/** The session's model, for its characters per token. */
	model?: { id: string };
}): ResourceDiagnostic | undefined {
	const budget = skillListingBudgetChars(input.contextWindow, input.model);
	const chars = input.listing.length;
	if (chars <= budget) return undefined;
	return {
		type: "warning",
		message: `Skill list too long: ${chars} chars, budget ${budget} · fix: octocode context check/apply, or /harness`,
	};
}
