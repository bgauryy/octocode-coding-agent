import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type AskAnswer, answerLine } from "../shared/ask-answer.ts";
import { INTERNAL_MESSAGE_TYPE } from "../shared/messages.ts";

/**
 * The words, besides the user's own messages, that a checkpoint keeps word for word beside them (`userMessagesSection`,
 * same budget): the user's `askUser` answers, which arrive as a tool result, and, in a subagent, the mail its parent
 * sent while it ran, which arrives as a custom message. Each starts with a label so the next model can tell its source.
 */

const ASK_ANSWER_LABEL = "[askUser answer]";
const PARENT_MESSAGE_LABEL = "[parent message]";

function isAnswer(value: unknown): value is AskAnswer {
	return isRecord(value) && typeof value.question === "string" && typeof value.answer === "string";
}

/** The answers the user gave in an `askUser` result, one per line; none for a declined or unavailable question. */
function askAnswerText(message: Record<string, unknown>): string | undefined {
	if (message.toolName !== "askUser" || message.isError === true || !isRecord(message.details)) return undefined;
	const answers = Array.isArray(message.details.answers) ? message.details.answers.filter(isAnswer) : [];
	return answers.length === 0 ? undefined : `${ASK_ANSWER_LABEL}\n${answers.map(answerLine).join("\n")}`;
}

/**
 * The texts the child's own parent sent in one team-mail message: the sender is the parent, and a message another agent
 * forwarded is that agent's to replay, so it is not kept as the parent's words (as `messageText` reads it).
 */
function parentMailTexts(message: Record<string, unknown>, parentId: string | undefined): string[] {
	if (parentId === undefined || message.customType !== INTERNAL_MESSAGE_TYPE || !isRecord(message.details)) return [];
	const mail: unknown[] = Array.isArray(message.details.messages) ? message.details.messages : [];
	return mail.flatMap((entry) =>
		isRecord(entry) &&
		entry.from === parentId &&
		(entry.forwardedBy === undefined || entry.forwardedBy === parentId) &&
		typeof entry.text === "string" &&
		entry.text !== ""
			? [`${PARENT_MESSAGE_LABEL} ${entry.text}`]
			: [],
	);
}

/** The labeled texts `message` adds to the kept words: an `askUser` answer, or the parent's mail to this agent (`parentId`). */
export function keptWordsOf(message: unknown, parentId?: string): string[] {
	if (!isRecord(message)) return [];
	if (message.role === "toolResult") {
		const answers = askAnswerText(message);
		return answers === undefined ? [] : [answers];
	}
	if (message.role === "custom") return parentMailTexts(message, parentId);
	return [];
}
