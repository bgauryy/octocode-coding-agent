import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { INTERNAL_MESSAGE_TYPE, JOB_TYPE, TIMER_TYPE } from "../shared/messages.ts";

/** A line that says only that the child waits: `Waiting on the build.`, `- Still waiting for #12's reply`, `**Awaiting** the review`. */
const WAIT_LINE = /^[\s>*_`#-]*(?:still\s+|now\s+)?(?:waiting|awaiting)\b/i;
/** A status line beside a wait: `Status: waiting`, `Pending: build job`, `Blocked on: peer`. It must carry no more than a label. */
const STATUS_LINE = /^[\s>*_`#-]*(?:current\s+)?(?:status|pending|blocked on|next|in progress)\b[^\n]{0,120}$/i;
/** A report longer than this has content of its own, whatever its lines start with. */
const WAITING_MAX_CHARS = 600;

/**
 * A final text that says only that the child waits (`Waiting on the build.`, `Still waiting`), on one line or several:
 * every non-empty line is a wait line or a short status line, and at least one is a wait line. Any other line is content.
 */
export function isWaitingLine(text: string): boolean {
	if (text.length > WAITING_MAX_CHARS) return false;
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	return (
		lines.length > 0 &&
		WAIT_LINE.test(lines[0]) &&
		lines.every((line) => WAIT_LINE.test(line) || STATUS_LINE.test(line))
	);
}

/**
 * Whether a call starts something that will wake the child later: a background bash job, a timer set, or a message that
 * asks a teammate or the parent for a reply (`agent` type `message` with `replyRequired`).
 */
function startsWait(event: Record<string, unknown>): boolean {
	const args = isRecord(event.args) ? event.args : {};
	return (
		(event.toolName === "bash" && args.background === true) ||
		(event.toolName === "timer" && args.op === "set") ||
		(event.toolName === "agent" && args.type === "message" && args.replyRequired === true)
	);
}

/** A reply the child asked for: the message it sent (when the result named it) and who must answer; unknown parts match any answer. */
export interface ReplyWait {
	/** The tool call that sent it, until its result names the message. */
	call?: unknown;
	id?: number;
	to: readonly string[];
}

/** What `noteWaits` keeps: the count, and the replies among it that only their own answer settles. */
export interface WaitState {
	waits: number;
	replies: ReplyWait[];
}

const isReplyRequest = (event: Record<string, unknown>): boolean =>
	event.toolName === "agent" &&
	isRecord(event.args) &&
	event.args.type === "message" &&
	event.args.replyRequired === true;

/** The reply a send waits for, from its result when it has one (`details.id`, `details.to`) and its `to` argument. */
function replyOf(event: Record<string, unknown>): ReplyWait {
	const details = isRecord(event.result) && isRecord(event.result.details) ? event.result.details : {};
	const args = isRecord(event.args) ? event.args : {};
	const named = Array.isArray(details.to) ? details.to : typeof details.to === "string" ? [details.to] : [];
	const to = (named.length > 0 ? named : typeof args.to === "string" ? [args.to] : []).filter(
		(each): each is string => typeof each === "string",
	);
	return { call: event.toolCallId, ...(typeof details.id === "number" ? { id: details.id } : {}), to };
}

/** Whether an incoming team message answers the wait: it replies to the sent message, or comes from one who was asked. */
function answers(wait: ReplyWait, incoming: Record<string, unknown>): boolean {
	if (wait.id === undefined && wait.to.length === 0) return true;
	if (wait.id !== undefined && incoming.replyTo === wait.id) return true;
	return typeof incoming.from === "string" && wait.to.includes(incoming.from);
}

/**
 * Counts what the child waits on, from its own events: a background job, a timer or a reply it asked for is pending until
 * its completion, wake or answer arrives (a failed call started nothing). A requested reply is settled only by its own
 * answer (a reply to that message, or a message from the one asked), so an unrelated team message does not end it. An
 * `every` timer stays counted until the run ends.
 */
export function noteWaits(state: WaitState, event: Record<string, unknown>): void {
	if (event.type === "tool_execution_start" && startsWait(event)) {
		state.waits++;
		if (isReplyRequest(event)) state.replies.push(replyOf(event));
	} else if (event.type === "tool_execution_end" && startsWait(event)) {
		const index = state.replies.findIndex((wait) => wait.call === event.toolCallId);
		if (event.isError === true) {
			state.waits = Math.max(0, state.waits - 1);
			if (index >= 0) state.replies.splice(index, 1);
		} else if (index >= 0) state.replies[index] = replyOf(event);
	} else if (event.type === "message_end" && isRecord(event.message)) {
		const { customType, details } = event.message;
		if (customType === JOB_TYPE || customType === TIMER_TYPE) state.waits = Math.max(0, state.waits - 1);
		else if (customType === INTERNAL_MESSAGE_TYPE)
			settleReplies(state, isRecord(details) ? details.messages : undefined);
	}
}

/** Drops each requested reply that one of the delivered messages answers. */
function settleReplies(state: WaitState, messages: unknown): void {
	const incoming = Array.isArray(messages) ? messages.filter(isRecord) : [];
	for (const message of incoming) {
		const index = state.replies.findIndex((wait) => answers(wait, message));
		if (index < 0) continue;
		state.replies.splice(index, 1);
		state.waits = Math.max(0, state.waits - 1);
	}
}
