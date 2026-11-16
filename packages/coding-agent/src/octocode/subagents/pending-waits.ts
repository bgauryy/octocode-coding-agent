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
 * Whether a call starts something that will wake the child later: a background bash job, a wait set, or a message that
 * asks a teammate or the parent for a reply (`agent` type `message` with `replyRequired`).
 */
function startsWait(event: Record<string, unknown>): boolean {
	const args = isRecord(event.args) ? event.args : {};
	return (
		(event.toolName === "bash" && args.background === true) ||
		(event.toolName === "wait" && (args.op === "set" || args.op === "on")) ||
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

/** A background job or timer started by this run; notices from earlier runs must not settle it. */
export interface WorkWait {
	kind: "job" | "timer";
	call: unknown;
	id?: string | number;
	log?: string;
	/** This job's declared deadline and settling allowance; removed with the matching wait. */
	until?: number;
	timeoutMs?: number;
}

/** What `noteWaits` keeps: identified work and replies, and their combined count. */
export interface WaitState {
	waits: number;
	replies: ReplyWait[];
	workWaits: WorkWait[];
	/** RPC tool-end events omit args; retain each wait operation's input until its result. */
	waitInputs: Map<unknown, unknown>;
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
 * its matching completion or answer arrives (a failed call started nothing). A repeating timer stays pending through
 * active wakes, until it ends or is cancelled. Unrelated or repeated notices cannot consume another wait.
 */
export function noteWaits(state: WaitState, inputEvent: Record<string, unknown>): void {
	let event = inputEvent;
	if (event.type === "tool_execution_start" && (event.toolName === "wait" || isReplyRequest(event)))
		state.waitInputs.set(event.toolCallId, event.args);
	else if (event.type === "tool_execution_end" && state.waitInputs.has(event.toolCallId)) {
		const args = state.waitInputs.get(event.toolCallId);
		state.waitInputs.delete(event.toolCallId);
		event = { ...event, args };
	}
	if (event.type === "tool_execution_start" && startsWait(event)) {
		if (isReplyRequest(event)) state.replies.push(replyOf(event));
		else state.workWaits.push({ kind: event.toolName === "bash" ? "job" : "timer", call: event.toolCallId });
	} else if (event.type === "tool_execution_end" && (startsWait(event) || event.toolName === "bash")) {
		if (isReplyRequest(event)) {
			const index = state.replies.findIndex((wait) => wait.call === event.toolCallId);
			if (index >= 0) {
				if (event.isError === true) state.replies.splice(index, 1);
				else state.replies[index] = replyOf(event);
			}
		} else finishStart(state, event);
	} else if (event.type === "tool_execution_end" && event.toolName === "wait" && event.isError !== true) {
		const args = isRecord(event.args) ? event.args : {};
		if (args.op === "off")
			state.workWaits = state.workWaits.filter(
				(wait) => wait.kind !== "timer" || (args.all !== true && wait.id !== args.id),
			);
	} else if (event.type === "message_end" && isRecord(event.message)) {
		const { customType, details } = event.message;
		if ((customType === JOB_TYPE || customType === TIMER_TYPE) && isRecord(details)) {
			const kind = customType === JOB_TYPE ? "job" : "timer";
			const terminal = ["done", "cancelled", "expired", "failed"].some((status) => status === details.status);
			if (kind === "job" || terminal) {
				const index = state.workWaits.findIndex(
					(wait) =>
						wait.kind === kind &&
						wait.id !== undefined &&
						wait.id === details.id &&
						(wait.log === undefined || details.log === undefined || wait.log === details.log),
				);
				if (index >= 0) state.workWaits.splice(index, 1);
			}
		} else if (customType === INTERNAL_MESSAGE_TYPE)
			settleReplies(state, isRecord(details) ? details.messages : undefined);
	}
	state.waits = state.workWaits.length + state.replies.length;
}

/** The start result identifies exactly the work its call created; an unmatched failure removes nothing. */
function finishStart(state: WaitState, event: Record<string, unknown>): void {
	const kind = event.toolName === "bash" ? "job" : "timer";
	const details = isRecord(event.result) && isRecord(event.result.details) ? event.result.details : {};
	const timer = isRecord(details.timer) ? details.timer : {};
	const id = kind === "job" ? details.job : timer.id;
	const index = state.workWaits.findIndex((wait) => wait.kind === kind && wait.call === event.toolCallId);
	if (index < 0) {
		// A foreground bash command can move to the background after its call starts.
		if (kind === "job" && event.isError !== true && typeof id === "string")
			state.workWaits.push({
				kind,
				call: event.toolCallId,
				id,
				...(typeof details.log === "string" ? { log: details.log } : {}),
			});
		return;
	}
	if (event.isError === true) {
		state.workWaits.splice(index, 1);
		return;
	}
	const wait = state.workWaits[index];
	if (typeof id === "number" || typeof id === "string") wait.id = id;
	if (kind === "job" && typeof details.log === "string") wait.log = details.log;
}

/** Drops each requested reply that one of the delivered messages answers. */
function settleReplies(state: WaitState, messages: unknown): void {
	const incoming = Array.isArray(messages) ? messages.filter(isRecord) : [];
	for (const message of incoming) {
		const index = state.replies.findIndex((wait) => answers(wait, message));
		if (index < 0) continue;
		state.replies.splice(index, 1);
	}
}
