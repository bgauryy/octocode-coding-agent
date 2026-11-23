import type { Usage } from "@octocodeai/octocode-ai";
import { NEEDS_APPROVAL } from "../permission/ask/text.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { AUDIT_NOTIFY_PREFIX } from "../permission/audit.ts";
import { EXPOSURE_NOTIFY_PREFIX } from "../permission/provenance/exposure.ts";
import { redactSecrets, visibleControls } from "@octocodeai/octocode-common/sanitize";
import { Thought } from "../render/thought.ts";
import { addUsage, contentText, emptyUsage } from "../shared/util.ts";
import { appliedFileOutcomes } from "../shared/file-outcomes.ts";
import { JOB_TYPE, TIMER_TYPE } from "../shared/messages.ts";
import { imagesOf } from "./screenshots.ts";
import { jobNotice } from "./report.ts";
import { type Compactions, endCompaction } from "./event-compactions.ts";
import { noteDeadlines } from "./event-deadlines.ts";
import { declaredTimeout, describeToolCall, replySteps, assistantText } from "./event-text.ts";
import { noteWaits, type ReplyWait, type WorkWait } from "./pending-waits.ts";
import { MODEL_EVENTS } from "./liveness.ts";
import { type ChildNotices, NoticeLog, NOTICES_INLINE, NOTICES_INLINE_CHARS } from "./notices.ts";
import { fallbackSwitch, ranModel, type RanModel, type UsageLimitRecord, usageLimitRecord } from "./event-ran.ts";
import type { FallbackSwitch } from "../../core/agent-session/fallback-switch.ts";

export type { Compactions };

export interface WatchdogLimits {
	/**
	 * Quiet time before a child counts as hung: no running tool, not settling after its answer, and no event at all. A
	 * running tool (or the hold on background jobs after the answer) is busy, however long it stays silent: it ends on
	 * its own deadline, and the user can stop it.
	 */
	idleMs: number;
	/**
	 * How long a busy child may stay busy past a call (or its answer) when that call declares no `timeout`; a call that
	 * declares one gets that. Past it plus `idleMs`, a tool that never ends (or a hold that never settles) is hung.
	 */
	busyMs: number;
}

/** One step of a running child, for the parent's live row. */
export interface ChildProgress {
	/** A tool call it started (`→ bash ls`). */
	activity?: string | undefined;
	/** A step of its reasoning that is not a tool call: a thought's gist (`✻ …`) or its narration (`› …`) once a reply ends. */
	step?: string | undefined;
	/** The gist of the thinking it streams now; empty once that thinking ends. */
	thinking?: string | undefined;
	/** Its usage so far. */
	usage: Usage;
	/** The assistant reply that just ended (with its `provider`, `model` and `usage`): its model may have no pricing. */
	reply?: Record<string, unknown>;
	/** The model of that reply and, after a `retry.fallbackModels` switch to it, that switch. */
	ran?: RanModel;
	/** A usage limit ended its turn (its `USAGE_LIMIT_ENTRY`): the provider and when the limit resets. */
	usageLimit?: UsageLimitRecord;
	/** The latest screenshot a tool returned. */
	image?: { data: string; mimeType: string };
	/** A tool call the child could not run without the user's approval (it has no one to ask). */
	denied?: boolean;
	/** The child waits for the user's answer to a dialog (`true`), or that answer arrived (`false`). */
	waiting?: boolean;
	/** The child compacts its context now (`true`), or that compaction ended (`false`). */
	compacting?: boolean;
	/** Its compactions so far, sent when one ends. */
	compactions?: Compactions;
	/** Its warnings and errors so far, sent when a new one arrives. */
	notices?: ChildNotices;
	/** Model requests it has made so far (assistant replies, compaction summaries not counted); sent with each reply. */
	requests?: number;
	/** Its first model reply started (sent once per run), so the provider has written the prompt cache for its prefix. */
	responding?: boolean;
	/** It edited a file after its last passing `bash verify` run (`false` once a later run passed). */
	editedAfterVerify?: boolean;
}

/**
 * What the events tell about a running child. The reducer (`reduceEvent`) updates it; the watchdog, `stop` and the exit
 * path of `runSubagent` read it, so the order of updates within one event is part of the behavior.
 */
export interface ChildState {
	/** Between `agent_start` and `agent_settled`: only a running child has anything to abort. */
	running: boolean;
	/** `agent_settled` arrived: the child leaves on its own once its input is closed. */
	settledSeen: boolean;
	toolsRunning: number;
	/** Assistant replies (model requests) seen so far in this run. */
	requests: number;
	/** A model turn, reply or tool call was seen: the child got past its startup, so a crash after it is no startup failure. */
	turnSeen: boolean;
	/** The first model reply was seen, streaming or ended. */
	responded: boolean;
	/** The answer is in and the child holds for its background jobs. */
	settling: boolean;
	/** While busy (tools running, or settling after the answer), the child is hung only past this moment. */
	busyUntil: number;
	/** The longest timeout of its pending background jobs: settling waits for timed jobs. */
	jobsMs: number;
	waits: number;
	/** The replies it asked for among `waits`, settled only by their own answer (`pending-waits.ts`). */
	replies: ReplyWait[];
	workWaits: WorkWait[];
	waitInputs: Map<unknown, unknown>;
	/** Its own timer woke the current turn, and no tool has run since: a text answer is only the reminder's echo. */
	timerWake: boolean;
	/** The last model request, reply, tool or compaction event (not any stdout byte); 0 before the first. */
	progressAt: number;
	/** A foreground call that declared its own `timeout` may run silent until this moment (0: none). */
	declaredUntil: number;
	/** Original deadlines by tool call, retained if a foreground command moves to the background. */
	toolDeadlines: Map<unknown, number>;
	/** A background job that declared its own `timeout` may run silent until this moment (0: none pending). */
	jobsUntil: number;
	lastActivity: string;
	usage: Usage;
	usageEntryIds: Set<string>;
	toolUsageIds: Set<string>;
	thought: Thought;
	compactions: Compactions;
	notices: ChildNotices;
	/** The run's distinct notices, the source of the saved log; `notices.kept` shares its first entries. */
	noticeLog: NoticeLog;
	/** The last `retry.fallbackModels` switch the child recorded: the model it continued on, why, and the billing change. */
	switched?: FallbackSwitch;
	/** Its last `bash verify` run passed and covers its edits so far (`current`), or it has edited since (`stale`). */
	verification?: "current" | "stale";
}

export function newChildState(): ChildState {
	return {
		running: false,
		settledSeen: false,
		toolsRunning: 0,
		requests: 0,
		turnSeen: false,
		responded: false,
		settling: false,
		busyUntil: 0,
		jobsMs: 0,
		waits: 0,
		replies: [],
		workWaits: [],
		waitInputs: new Map(),
		timerWake: false,
		progressAt: 0,
		declaredUntil: 0,
		toolDeadlines: new Map(),
		jobsUntil: 0,
		lastActivity: "started",
		usage: emptyUsage(),
		usageEntryIds: new Set(),
		toolUsageIds: new Set(),
		thought: new Thought(),
		compactions: { done: 0, aborted: 0, failed: 0 },
		notices: { kept: [], more: 0 },
		noticeLog: new NoticeLog(),
	};
}

/** What the lifecycle does for an event, in order, once the state is updated. */
export type ChildEffect =
	| { kind: "progress"; update: ChildProgress }
	/** A dialog of the child (`extension_ui_request`) for the relay. */
	| { kind: "ui"; event: Record<string, unknown> }
	/** The child refused its task: the run fails with this message and stops. */
	| { kind: "rejected"; message: string }
	/** Tell the child to shut down in order (close its stdin). */
	| { kind: "close" }
	/** The run is over (`agent_settled`); `aborted` is what the child said, before the lifecycle weighs a stall. */
	| { kind: "settled"; aborted: boolean }
	/** A message that is not the child's own reply reached it. `job`: the first line of its own background bash job's end notice (`JOB_TYPE`). */
	| { kind: "incoming"; role: unknown; job?: string; quiet?: true; reminder?: boolean }
	/** An assistant reply ended: the report tracker reads its text. */
	| {
			kind: "answer";
			text: string | undefined;
			stopReason: unknown;
			errorMessage: unknown;
			waiting: boolean;
			reminder: boolean;
	  }
	/** The first model reply of the run started (streamed, whole, or implied by a tool call): the provider has written the prompt cache for the prefix. */
	| { kind: "responding" }
	/** An assistant reply ended: `count` replies so far in this run; `continues`: it asked for tools, so the child goes on. */
	| { kind: "request"; count: number; continues: boolean };

export function parseEvent(line: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(line) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The prompt command's own answer; every other `response` is for a command this parent never sends. */
function promptResponse(event: Record<string, unknown>): ChildEffect[] {
	if (event.command !== "prompt") return [];
	if (event.success === false)
		return [
			{
				kind: "rejected",
				message: `Subagent rejected its task: ${typeof event.error === "string" ? event.error : "no reason given"}`,
			},
		];
	// A feature command consumed the prompt: no run starts, so no `agent_settled` will come.
	return isRecord(event.data) && event.data.disposition === "handled" ? [{ kind: "close" }] : [];
}

/**
 * A child's `notify` of level warning or error (the audit and exposure channels and info notes are not for the parent's report): kept
 * whole, folded into its identical earlier one with a count, else logged as a new notice; it joins the inline page while
 * the page has room, and once one does not fit, none after it joins (the page is a prefix, so it never skips ahead).
 */
function noteNotice(state: ChildState, event: Record<string, unknown>): boolean {
	const [message, level] = [event.message, event.notifyType];
	if (
		event.method !== "notify" ||
		typeof message !== "string" ||
		message.startsWith(AUDIT_NOTIFY_PREFIX) ||
		message.startsWith(EXPOSURE_NOTIFY_PREFIX) ||
		(level !== "warning" && level !== "error")
	)
		return false;
	// A notice can quote a credential (a provider's 401 body); redacted here, the kept list, the saved file and `lastError` all hold the clean text.
	const text = redactSecrets(visibleControls(message.replace(/\s+/g, " ").trim()));
	const { notice, repeat } = state.noticeLog.add(level, text);
	if (!repeat) {
		const { kept } = state.notices;
		const room =
			notice !== undefined &&
			state.notices.more === 0 &&
			kept.length < NOTICES_INLINE &&
			kept.reduce((chars, entry) => chars + entry.text.length, text.length) <= NOTICES_INLINE_CHARS;
		if (room) kept.push(notice);
		else state.notices.more += 1;
	}
	if (level === "error") state.notices.lastError = text;
	return true;
}

/** A finished tool call moves the run's verification state: a passing `bash verify` run covers the edits so far, and a later edit leaves it behind. */
function noteVerification(
	state: ChildState,
	event: Record<string, unknown>,
	progress: (update: { editedAfterVerify: boolean }) => void,
): void {
	// A `file` batch in which a query failed is an error result that still applied the others.
	const applied =
		event.toolName === "file" && isRecord(event.result) && appliedFileOutcomes(event.result.details).length > 0;
	if (event.isError === true && !applied) return;
	if (event.toolName === "file") {
		if (state.verification !== "current") return;
		state.verification = "stale";
		progress({ editedAfterVerify: true });
		return;
	}
	const details = isRecord(event.result) ? event.result.details : undefined;
	const receipt = isRecord(details) ? details.verification : undefined;
	if (!isRecord(receipt) || receipt.state !== "finished" || receipt.exitCode !== 0 || receipt.stale === true) return;
	if (state.verification === "stale") progress({ editedAfterVerify: false });
	state.verification = "current";
}

/**
 * Applies one parsed event of the child to `state` and returns what the lifecycle does about it, in order. `now` is the
 * clock for the busy deadline. Nothing here touches the process, the report or the parent's row.
 */
export function reduceEvent(
	state: ChildState,
	event: Record<string, unknown>,
	limits: WatchdogLimits,
	now: number,
): ChildEffect[] {
	const type = event.type;
	if (type === "response") return promptResponse(event);
	if (type === "extension_ui_dismiss") return [{ kind: "ui", event }];
	if (type === "extension_ui_request") {
		const ui: ChildEffect = { kind: "ui", event };
		return noteNotice(state, event)
			? [ui, { kind: "progress", update: { notices: structuredClone(state.notices), usage: state.usage } }]
			: [ui];
	}
	// Calls a tool makes itself (another tool) are part of that call, not activity of their own.
	if (event.parentToolCallId) return [];
	noteWaits(state, event);
	noteDeadlines(state, event, now);
	if (typeof type === "string" && MODEL_EVENTS.has(type)) state.progressAt = now;
	const effects: ChildEffect[] = [];
	const progress = (update: Omit<ChildProgress, "usage">) =>
		effects.push({ kind: "progress", update: { ...update, usage: state.usage } });
	if (type === "entry_appended") state.switched = fallbackSwitch(event.entry) ?? state.switched;
	const usageLimit = type === "entry_appended" ? usageLimitRecord(event.entry) : undefined;
	if (usageLimit) progress({ usageLimit });
	if (type === "entry_appended" && isRecord(event.entry) && event.entry.type === "usage") {
		const entry = event.entry;
		if (typeof entry.id !== "string" || state.usageEntryIds.has(entry.id)) return effects;
		state.usageEntryIds.add(entry.id);
		addUsage(state.usage, entry.usage);
		progress({});
		return effects;
	}
	if (type === "agent_start") state.running = true;
	if (type === "turn_start" || type === "message_update" || type === "tool_execution_start") state.turnSeen = true;
	const ended = type === "message_end" && isRecord(event.message) && event.message.role === "assistant";
	state.turnSeen ||= ended;
	const replying = ended || type === "message_update" || type === "tool_execution_start";
	if (replying && !state.responded) effects.push({ kind: "responding" });
	state.responded ||= replying;
	if (type === "compaction_start") {
		state.lastActivity = "compacting its context";
		progress({ compacting: true });
		return effects;
	}
	if (type === "compaction_end") {
		endCompaction(state.compactions, state.usage, event);
		state.lastActivity = "compacted its context";
		progress({ compacting: false, compactions: { ...state.compactions } });
		return effects;
	}
	if (type === "agent_settled") {
		state.running = false;
		state.settledSeen = true;
		// The run is over and the report is in: the child has nothing left to do, so the lifecycle tells it to leave.
		return [{ kind: "settled", aborted: event.aborted === true }];
	}
	// A new turn or a streaming reply means the previous turn's tools are over, even one that never reported its end.
	if (type === "turn_start" || type === "message_update") {
		state.toolsRunning = 0;
	}
	// A turn after the answer (a message from the parent woke it) is a model turn again, not settling.
	if (type === "turn_start") state.settling = false;
	if (type === "message_update" && isRecord(event.assistantMessageEvent)) {
		const update = event.assistantMessageEvent;
		if (update.type === "thinking_start") state.thought.reset();
		if (update.type === "thinking_delta" && typeof update.delta === "string" && state.thought.add(update.delta))
			progress({ thinking: state.thought.gist ?? "" });
		return effects;
	}
	if (type === "tool_execution_start") {
		state.timerWake = false;
		state.toolsRunning++;
		state.settling = false;
		const own = declaredTimeout(event.args);
		state.busyUntil = Math.max(state.busyUntil, now + (own ?? limits.busyMs) + limits.idleMs);
		state.lastActivity = describeToolCall(event.toolName, event.args);
		progress({ activity: state.lastActivity });
	}
	if (type === "tool_execution_end") {
		state.toolsRunning = Math.max(0, state.toolsRunning - 1);
		const image = imagesOf(event.result).at(-1);
		if (image) progress({ image });
		const result = event.result;
		if (event.isError === true && isRecord(result) && contentText(result.content).startsWith(NEEDS_APPROVAL))
			progress({ denied: true });
		noteVerification(state, event, progress);
	}
	if (type !== "message_end" || !isRecord(event.message)) return effects;
	const message = event.message;
	if (message.role !== "assistant") {
		// A background `bash verify` job reports when it ends, as a message rather than a tool result.
		// A turn its own timer started (`TIMER_TYPE`) is a reminder until a tool runs; any other new message ends that.
		if (message.role === "custom" || message.role === "user") state.timerWake = message.customType === TIMER_TYPE;
		if (message.customType === JOB_TYPE) noteVerification(state, { result: { details: message.details } }, progress);
		if (message.role === "toolResult" && isRecord(message.usage)) {
			const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
			if (id === undefined || !state.toolUsageIds.has(id)) {
				if (id !== undefined) state.toolUsageIds.add(id);
				addUsage(state.usage, message.usage);
				progress({});
			}
		}
		return [
			...effects,
			{
				kind: "incoming",
				role: message.role,
				...jobNotice(message),
				...(message.customType === TIMER_TYPE ? { reminder: true } : {}),
			},
		];
	}
	addUsage(state.usage, message.usage);
	state.requests += 1;
	delete state.notices.lastError;
	state.thought.reset();
	for (const step of replySteps(message)) progress({ step });
	const ran = ranModel(message, state.switched);
	progress({ reply: message, thinking: "", requests: state.requests, ...(ran ? { ran } : {}) });
	state.settling = message.stopReason !== "toolUse";
	if (state.settling) state.busyUntil = now + Math.max(state.jobsMs, limits.busyMs) + limits.idleMs;
	state.lastActivity = state.settling ? "answered; settling" : "model turn";
	effects.push({ kind: "request", count: state.requests, continues: message.stopReason === "toolUse" });
	effects.push({
		kind: "answer",
		text: assistantText(message),
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
		waiting: state.waits > 0,
		reminder: state.timerWake && message.stopReason === "stop",
	});
	return effects;
}
