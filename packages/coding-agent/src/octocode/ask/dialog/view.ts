import type { Question, Reply } from "@octocodeai/octocode-contracts";
import type { RemoteAnswer } from "../../../core/features/types.ts";
import type { AskView } from "../../shared/ask-view.ts";
import { viewOf } from "../question.ts";
import { TYPE_OWN } from "./answers.ts";

/** What the terminal dialog draws for a question, and how the web workspace or an RPC client answers it. */

/**
 * The question as a card: `viewOf`'s rows, except that a free-text question keeps one row, the write-in, which opens its
 * editor (the dialog opens the editor first and Esc returns to that row).
 */
export function questionView(q: Question): AskView {
	const view = viewOf(q);
	if (q.type !== "text") return view;
	return { ...view, options: [{ label: TYPE_OWN }], writeIn: { label: TYPE_OWN, title: q.question } };
}

/**
 * How the web workspace and RPC clients answer the terminal card (the broker's first answer wins and closes it). A lone
 * single-choice or free-text question is answered by a choice or text; a batch or a multi-select by one reply per
 * question, checked against the questions. A choice that names no option of the question is not an answer.
 */
export function remoteAnswer(
	questions: readonly Question[],
	hold?: () => void,
): { remote: RemoteAnswer<Reply[]> } | undefined {
	const [q] = questions;
	if (!q) return undefined;
	if (questions.length !== 1 || (q.type !== "text" && q.type !== "choice"))
		return {
			remote: {
				title: `${questions.length > 1 ? `${questions.length} questions: ` : ""}${q.question}`,
				questions,
				...(hold ? { hold } : {}),
			},
		};
	const options = q.options ?? [];
	const view = questionView(q);
	return {
		remote: {
			title: q.question,
			options: options.map((option) => option.label),
			allowsText: true,
			...(hold ? { hold } : {}),
			ask: { ...view, options: view.options.slice(0, options.length), writeIn: false as const },
			answer: (answer: { choice: string } | { text: string }): Reply[] | undefined => {
				if ("text" in answer) {
					const text = answer.text.trim();
					return text ? [{ id: q.id, picks: [], text }] : undefined;
				}
				const option = options.find((candidate) => candidate.label === answer.choice);
				return option ? [{ id: q.id, picks: [option.id] }] : undefined;
			},
		},
	};
}
