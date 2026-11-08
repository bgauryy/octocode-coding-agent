import { CANCEL_REASONS, type CancelReason, QUESTION_LIMITS, type Question, type Reply } from "./question.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const isCancelReason = (value: unknown): value is CancelReason =>
	(CANCEL_REASONS as readonly unknown[]).includes(value);

/** One reply of what a peer sent for `question`, or undefined when it does not fit that question. */
function checkedReply(question: Question, raw: Record<string, unknown>): Reply | undefined {
	if (raw.cancelled !== undefined) {
		return isCancelReason(raw.cancelled) && raw.picks === undefined && raw.text === undefined
			? { id: question.id, cancelled: raw.cancelled }
			: undefined;
	}
	if (!Array.isArray(raw.picks) || raw.picks.length > QUESTION_LIMITS.options) return undefined;
	if (raw.text !== undefined && (typeof raw.text !== "string" || raw.text.length > QUESTION_LIMITS.text))
		return undefined;
	const ids = new Set((question.options ?? []).map((option) => option.id));
	const picks: string[] = [];
	for (const pick of raw.picks) {
		// An id the question does not offer, or one picked twice, is not an answer to it.
		if (typeof pick !== "string" || !ids.has(pick) || picks.includes(pick)) return undefined;
		picks.push(pick);
	}
	const text = raw.text;
	if (question.type === "text")
		return picks.length === 0 && text !== undefined ? { id: question.id, picks, text } : undefined;
	// Typed text answers only where the question offers a write-in, or beside the deny-with-a-note option.
	const notes = (question.options ?? []).some((option) => option.role === "deny_note" && picks.includes(option.id));
	if (text !== undefined && !question.writeIn && !notes) return undefined;
	if (question.type !== "multi" && picks.length > 1) return undefined;
	// A confirmation or approval is decided by an option; its note rides beside it (an approval's deny-with-note).
	if ((question.type === "confirm" || question.type === "approval") && picks.length !== 1) return undefined;
	return { id: question.id, picks, ...(text !== undefined ? { text } : {}) };
}

/**
 * The replies a peer (an RPC client, a browser, a subagent's parent) sent for `questions`, checked against them: exactly
 * one per question, in the questions' order, picks naming options the question offers (one for a choice, confirm or
 * approval; distinct ones for a multi), text only for a text question or a write-in, a cancellation naming a known
 * reason. Anything else rejects the whole answer (undefined): a reply that does not fit is never guessed at.
 */
export function checkedReplies(questions: readonly Question[], raw: unknown): Reply[] | undefined {
	if (!Array.isArray(raw) || raw.length !== questions.length) return undefined;
	const byId = new Map<string, Record<string, unknown>>();
	for (const value of raw) {
		const reply = record(value);
		if (!reply || typeof reply.id !== "string" || byId.has(reply.id)) return undefined;
		byId.set(reply.id, reply);
	}
	const replies: Reply[] = [];
	for (const question of questions) {
		const found = byId.get(question.id);
		const reply = found && checkedReply(question, found);
		if (!reply) return undefined;
		replies.push(reply);
	}
	return replies;
}
