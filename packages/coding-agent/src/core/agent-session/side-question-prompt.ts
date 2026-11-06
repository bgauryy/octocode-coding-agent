import { renderInstruction } from "../prompt-template.ts";

/** One earlier side question and its answer, kept as reference for the next side question. */
export interface SideQuestionExchange {
	question: string;
	answer: string;
}

/** The side question's system prompt (`octocode/instructions/workflows/side-question.md`). */
export const SIDE_QUESTION_SYSTEM_PROMPT = renderInstruction("workflows/side-question.md");

/** Bound the serialized payload, including JSON escaping, without ever truncating the current question. */
export function buildSideQuestionPrompt(
	question: string,
	transcript: string,
	exchanges: readonly SideQuestionExchange[],
	maxChars: number,
): { prompt: string; history: SideQuestionExchange[] } {
	if (!Number.isFinite(maxChars) || maxChars < 1)
		throw new Error("The side question does not fit this model's context window.");
	const limit = Math.floor(maxChars);
	let history = exchanges.slice(-20);
	let conversation = transcript;
	let truncated = exchanges.length > history.length;
	const encode = () => JSON.stringify({ reference: { conversation, truncated, sideThread: history }, question });
	while (history.length && JSON.stringify(history).length > limit / 4) {
		history = history.slice(1);
		truncated = true;
	}
	let prompt = encode();
	while (prompt.length > limit) {
		if (conversation.length) {
			conversation = conversation.slice(Math.min(conversation.length, prompt.length - limit));
			// A suffix must not start halfway through a Unicode surrogate pair.
			if (/^[\uDC00-\uDFFF]/.test(conversation)) conversation = conversation.slice(1);
			truncated = true;
		} else if (history.length) {
			history = history.slice(1);
			truncated = true;
		} else throw new Error("The side question does not fit this model's context window.");
		prompt = encode();
	}
	return { prompt, history };
}
