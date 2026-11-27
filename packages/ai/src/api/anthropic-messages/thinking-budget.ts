/** Anthropic's smallest accepted `budget_tokens`. */
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

/** Tokens always left for the answer when the thinking budget shares `max_tokens`. */
const ANSWER_TOKENS = 1024;

/**
 * Fits a Claude thinking budget under `maxTokens`, halving it until it fits. `budget_tokens` is rendered into the
 * prompt, so every change invalidates the cached messages; near the context limit `maxTokens` shrinks with each turn,
 * and a budget that tracked it exactly would miss the message cache on every request. Halving changes it a few times
 * at most. Returns 0 when not even the minimum budget fits, meaning "answer without thinking".
 */
export function fitClaudeThinkingBudget(budget: number, maxTokens: number): number {
	const room = maxTokens - ANSWER_TOKENS;
	let fitted = budget;
	while (fitted > room && fitted >= ANTHROPIC_MIN_THINKING_BUDGET * 2) fitted = Math.floor(fitted / 2);
	return fitted <= room && fitted >= ANTHROPIC_MIN_THINKING_BUDGET ? fitted : 0;
}
