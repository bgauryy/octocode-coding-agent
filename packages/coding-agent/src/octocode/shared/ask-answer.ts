/** One answer to an `askUser` question, and how the model reads it (the dialog, the tool result and the compaction checkpoint share both). */
export interface AskAnswer {
	question: string;
	answer: string;
	custom: boolean;
	/** Multi-select with a write-in: the toggled option labels, kept apart from the typed text so the model can tell them apart. */
	picks?: string[];
	typed?: string;
}

/** `"question" → answer`; a multi-select write-in names its picks and its typed text apart, since the joined answer cannot be split back. */
export function answerLine(entry: AskAnswer): string {
	if (!entry.custom) return `"${entry.question}" → ${entry.answer}`;
	return `"${entry.question}" → ${entry.picks?.length ? `${entry.picks.join(", ")} + (typed) ${entry.typed ?? ""}` : `(typed) ${entry.answer}`}`;
}
