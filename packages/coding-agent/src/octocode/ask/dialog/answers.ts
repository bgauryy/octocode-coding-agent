import type { AskAnswer } from "../../shared/ask-answer.ts";

export type { AskAnswer };

/** askUser's questions and answers, and the rows the dialog and the plain-dialog fallback add to a question. */

interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	/** The question as answered and sent to hosts without the card; with `forwarded`, the child's text leads it. */
	question: string;
	/** A forwarded child question: the card shows `ask` bold and the child's text as a collapsible body. */
	forwarded?: { label: string; text: string; ask: string };
	header?: string;
	options: AskOption[];
	multiSelect?: boolean;
}

export interface AskResult {
	answers: AskAnswer[];
	cancelled: boolean;
	reason?: "unavailable" | "aborted";
}

/** The answer to `question` from the options picked (`picks`, in order) and the text typed in; a write-in makes it custom. */
export function answerOf(question: string, picks: string[], typed?: string): AskAnswer {
	return {
		question,
		answer: [...picks, ...(typed ? [typed] : [])].join(", "),
		custom: typed !== undefined,
		...(typed !== undefined && picks.length ? { picks, typed } : {}),
	};
}

/** The write-in row and the multi-select submit row, in the dialog and in `degrade.ts`. */
export const TYPE_OWN = "Write an answer";
export const SUBMIT_PICKS = "Submit selection";
