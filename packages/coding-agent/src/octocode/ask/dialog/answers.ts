import type { ExtensionUIRemoteAnswer } from "../../../core/features/types.ts";
import type { AskAnswer } from "../../shared/ask-answer.ts";
import { type AskView, isRecommended } from "../../shared/ask-view.ts";

export type { AskAnswer };

/** Questions, answers and the rows each question shows, shared by the dialog and the RPC fallback (`tool.ts`). */

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

/** The write-in row and the multi-select submit row, in this dialog and in the RPC fallback (`tool.ts`). */
export const TYPE_OWN = "Write an answer";
export const SUBMIT_PICKS = "Submit selection";

/** The question as a card: the rows of `rows` (the write-in row drawn as such), the recommendation starred. */
export function questionView(q: AskQuestion): AskView {
	return {
		question: q.forwarded?.ask ?? q.question,
		...(q.forwarded ? { body: { label: q.forwarded.label, text: q.forwarded.text, collapsible: true } } : {}),
		options: rows(q).map((label, index) => {
			const option = q.options[index];
			return {
				label,
				...(option?.description ? { description: option.description } : {}),
				...(option && isRecommended(label) ? { recommended: true } : {}),
			};
		}),
		writeIn: { label: TYPE_OWN, title: q.question },
		...(q.multiSelect ? { multiSelect: true } : {}),
	};
}

/** Option rows, then the free-text row, then (multi-select only) the row that confirms the toggled set. */
export const rows = (q: AskQuestion) => [
	...q.options.map((option) => option.label),
	TYPE_OWN,
	...(q.multiSelect ? [SUBMIT_PICKS] : []),
];

/**
 * How the web workspace and RPC clients answer a lone single-choice or free-text question (the broker's first answer
 * wins and closes the terminal card). A batch or a multi-select stays terminal-only: one answer cannot fill its tabs.
 */
export function remoteAnswer(questions: AskQuestion[]): { remote: ExtensionUIRemoteAnswer<AskResult> } | undefined {
	const [q] = questions;
	if (!q || questions.length !== 1 || q.multiSelect) return undefined;
	const view = questionView(q);
	return {
		remote: {
			title: q.question,
			options: q.options.map((option) => option.label),
			allowsText: true,
			ask: { ...view, options: view.options.slice(0, q.options.length), writeIn: false as const },
			answer: (answer: { choice: string } | { text: string }): AskResult | undefined => {
				const text = "text" in answer ? answer.text.trim() : "";
				if ("text" in answer && !text) return undefined;
				return {
					answers: [answerOf(q.question, "choice" in answer ? [answer.choice] : [], text || undefined)],
					cancelled: false,
				};
			},
		},
	};
}
