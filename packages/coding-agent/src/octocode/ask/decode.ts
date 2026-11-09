import type { CancelReason, Question, QuestionOption, Reply } from "@octocodeai/octocode-contracts";
import { answerOf, type AskResult } from "./dialog/answers.ts";
import type { AskAnswer } from "../shared/ask-answer.ts";

/**
 * The one decoder: a `Reply` read back for the asker that built the `Question`. Options are found by id in the question
 * the harness asked, and a permission answer by the option's `role` there: never by matching a label, and never by a
 * role the reply itself carries.
 */

/** A permission dialog's answer, as `permission/ask/types.ts` names it: once, this call for the session, its kind for the session, deny (with a note), deny this call for the session, or undefined when dismissed. */
type PermissionAnswer = "once" | "session" | "kind" | "deny" | "deny_session" | { deny: string } | undefined;

type Answered = Extract<Reply, { picks: string[] }>;
type Cancelled = Extract<Reply, { cancelled: CancelReason }>;

const isCancelled = (reply: Reply | undefined): reply is Cancelled => reply !== undefined && "cancelled" in reply;
const answered = (reply: Reply | undefined): reply is Answered => reply !== undefined && !isCancelled(reply);

/** The reply to question `id`, if the host sent one. */
const replyTo = (replies: readonly Reply[], id: string): Reply | undefined => replies.find((reply) => reply.id === id);

/** The question's options the reply picked, each once, in the question's own order. Unknown ids pick nothing. */
function picked(question: Question, reply: Answered): QuestionOption[] {
	const ids = new Set(reply.picks);
	return (question.options ?? []).filter((option) => ids.has(option.id));
}

/** What the reply typed: a write-in, or a `text` question's answer. Whitespace is no text. */
const typedOf = (reply: Answered): string | undefined => reply.text?.trim() || undefined;

/** One askUser answer from a reply, or undefined when it holds none (an empty answer is no answer). */
function askUserAnswer(question: Question, reply: Answered): AskAnswer | undefined {
	const typed = typedOf(reply);
	if (question.type === "text") return typed ? answerOf(question.question, [], typed) : undefined;
	const options = picked(question, reply);
	// A single choice takes one option.
	const picks = (question.type === "multi" ? options : options.slice(0, 1)).map((option) => option.label);
	if (picks.length === 0 && !typed) return undefined;
	return answerOf(question.question, picks, typed);
}

/**
 * askUser's result for `replies`: every answer given, and whether any question was cancelled or left empty. The terminal
 * dialog can leave a middle question unanswered and still keep the later ones, so answers are not cut at the first gap.
 * `reason` is that first gap's, set for unavailable and aborted (a decline, a timeout or a missing reply leaves it unset, as
 * a decline).
 */
export function askUserResult(questions: readonly Question[], replies: readonly Reply[]): AskResult {
	const answers: AskAnswer[] = [];
	let gap: { reason: CancelReason | undefined } | undefined;
	for (const question of questions) {
		const reply = replyTo(replies, question.id);
		const answer = answered(reply) ? askUserAnswer(question, reply) : undefined;
		if (answer) answers.push(answer);
		else gap ??= { reason: isCancelled(reply) ? reply.cancelled : undefined };
	}
	if (!gap) return { answers, cancelled: false };
	const { reason } = gap;
	return { answers, cancelled: true, ...(reason === "unavailable" || reason === "aborted" ? { reason } : {}) };
}

/**
 * The permission answer for an `approval` question, by the role of the option picked: allow_once, allow_session and
 * allow_kind allow; deny denies; deny_session denies and remembers it for the session; deny_note denies with the text
 * typed as the agent's note (none typed: a plain deny).
 * Undefined (dismissed) for a cancelled or missing reply, a pick that is no option of the question, an option without
 * one of those roles, and any question that is not an approval.
 */
export function permissionAnswer(question: Question, reply: Reply | undefined): PermissionAnswer {
	if (question.type !== "approval" || !answered(reply)) return undefined;
	const option = picked(question, reply)[0];
	switch (option?.role) {
		case "allow_once":
			return "once";
		case "allow_session":
			return "session";
		case "allow_kind":
			return "kind";
		case "deny":
			return "deny";
		case "deny_session":
			return "deny_session";
		case "deny_note": {
			const note = typedOf(reply);
			return note ? { deny: note } : "deny";
		}
		default:
			return undefined;
	}
}

/** Whether a confirm question was answered yes. A cancelled reply, or a pick that is not its `yes` option, is no. */
export function confirmed(question: Question, reply: Reply | undefined): boolean {
	if (question.type !== "confirm" || !answered(reply)) return false;
	return picked(question, reply)[0]?.role === "yes";
}

/** The text an input question was answered with, as typed; undefined when cancelled. */
export function inputText(reply: Reply | undefined): string | undefined {
	return answered(reply) ? reply.text : undefined;
}
