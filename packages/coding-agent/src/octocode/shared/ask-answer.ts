/** One answer to an `askUser` question, and how the model reads it (the dialog, the tool result and the compaction checkpoint share both). */
export interface AskAnswer {
	question: string;
	answer: string;
	custom: boolean;
	/** Multi-select with a write-in: the toggled option labels, kept apart from the typed text so the model can tell them apart. */
	picks?: string[];
	typed?: string;
	/** The host took the recommended option(s) when `seconds` ran out; `reason` is theirs, as the model wrote it. */
	auto?: { seconds: number; reason: string };
}

/** `"question" → answer`; a multi-select write-in names its picks and its typed text apart, since the joined answer cannot be split back. An automatic answer says so and repeats its reason. */
export function answerLine(entry: AskAnswer): string {
	if (entry.auto)
		return `"${entry.question}" → ${entry.answer} (auto: no answer in ${entry.auto.seconds}s)${entry.auto.reason ? `; reason: ${entry.auto.reason}` : ""}`;
	if (!entry.custom) return `"${entry.question}" → ${entry.answer}`;
	return `"${entry.question}" → ${entry.picks?.length ? `${entry.picks.join(", ")} + (typed) ${entry.typed ?? ""}` : `(typed) ${entry.answer}`}`;
}
