import fs from "node:fs";
import { agentCall } from "../shared/agent-call.ts";
import { AGENT_RESULT_TYPE, JOB_TYPE } from "../shared/messages.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { tildePath } from "../shared/home.ts";
import { stringOrEmpty } from "../shared/util.ts";
import { type ChildFiles, childFiles } from "../shared/session-children.ts";
import { describeFiles } from "../subagents/children.ts";
import { flatLine, shownLine } from "./store.ts";

/**
 * Background work recorded in a session's entries: `bash` calls with `background: true` (result `details.job` and
 * `details.log`, report `JOB_TYPE` with the same log) and background `agent` calls (result `details.status`
 * `background` and `details.id`, report `AGENT_RESULT_TYPE` with the same id). A start without its report is work
 * still running in this process, or, read when a session starts, work that ended with an earlier process unreported.
 */
interface BackgroundWork {
	kind: "bash" | "agent";
	id: string;
	/** The bash command, or the subagent's goal (else its task), whole on one line. */
	label: string;
	/** The label is the subagent's goal, not its task. */
	goal?: boolean;
	/** Why it was started: the starting call's `reason`, on one line and capped. */
	why?: string;
	/** A bash job's log file. */
	log?: string;
	/** A subagent's saved conversation and report, as its start recorded them (`details.session`). */
	files?: ChildFiles;
}

/** Bash job ids restart with each extension instance; the log path (id plus start time) is unique. */
const jobKey = (id: string, log: string | undefined) => (log ? `log:${log}` : `id:${id}`);
const agentKey = (id: string, runId: unknown) => `agent:${id}${typeof runId === "string" ? `:${runId}` : ""}`;

/** Characters kept of a start's reason, as the brief keeps of an item's why. */
const WHY_CHARS = 160;

/** The call's reason as `why`, or nothing when it gave none. */
function whyOf(input: Record<string, unknown>): { why?: string } {
	const why = typeof input.reason === "string" ? shownLine(input.reason, WHY_CHARS) : "";
	return why ? { why } : {};
}

/** The unreported work in `entries`, oldest first; with `since` (ms), only work started at or after it. */
export function unreportedWork(entries: readonly unknown[], since?: number): BackgroundWork[] {
	const args = new Map<string, Record<string, unknown>>();
	const started = new Map<string, BackgroundWork>();
	const reported = new Set<string>();
	const latestAgent = new Map<string, string>();
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "custom_message") {
			const details = asRecord(entry.details);
			const id = typeof details.id === "string" ? details.id : undefined;
			if (!id) continue;
			if (entry.customType === JOB_TYPE) {
				const log = typeof details.log === "string" ? details.log : undefined;
				reported.add(jobKey(id, log));
			} else if (entry.customType === AGENT_RESULT_TYPE) reported.add(agentKey(id, details.runId));
			continue;
		}
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content)
				if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && isRecord(part.arguments))
					args.set(part.id, part.arguments);
			continue;
		}
		if (message.role !== "toolResult" || message.isError === true || !isRecord(message.details)) continue;
		if (since !== undefined && !(Date.parse(stringOrEmpty(entry.timestamp)) >= since)) continue;
		const details = message.details;
		const input = args.get(String(message.toolCallId)) ?? {};
		if (message.toolName === "bash" && typeof details.job === "string") {
			const log = typeof details.log === "string" ? details.log : undefined;
			started.set(jobKey(details.job, log), {
				kind: "bash",
				id: details.job,
				label: flatLine(stringOrEmpty(input.command)),
				...whyOf(input),
				...(log ? { log } : {}),
			});
		} else if (message.toolName === "agent" && details.status === "background" && typeof details.id === "string") {
			// Flat `agent` fields, or the `{type, input}` envelope older sessions recorded.
			const task = agentCall(input).input;
			const goal = typeof task.goal === "string" ? flatLine(task.goal) : "";
			const files = childFiles(details.session);
			// A start receipt has no current report; report.md may be left by an earlier continuation.
			delete files.report;
			const key = agentKey(details.id, details.runId);
			const previous = latestAgent.get(details.id);
			if (previous) started.delete(previous);
			latestAgent.set(details.id, key);
			// Legacy records have no run id: their later launch starts a new report window in transcript order.
			if (typeof details.runId !== "string") reported.delete(key);
			started.set(key, {
				kind: "agent",
				id: details.id,
				...(goal ? { label: goal, goal: true } : { label: flatLine(stringOrEmpty(task.task)) }),
				...whyOf(input),
				...(Object.keys(files).length > 0 ? { files } : {}),
			});
		}
	}
	return [...started].filter(([key]) => !reported.has(key)).map(([, work]) => work);
}

/** Characters kept of an unanswered call's arguments in the resume brief. */
const CALL_CHARS = 200;

/**
 * The tool calls of the latest assistant message on `entries` that have no recorded result, each as `name(arguments)`.
 * Read when a session is resumed: the process ended (a crash, a kill, a failed save) while they ran or before their
 * results were saved, so they may have done their work. Stops at a later user message, which means they were already
 * dealt with, and an errored or aborted reply never reaches the model, so its calls do not count.
 */
export function unansweredCalls(entries: readonly unknown[]): string[] {
	const answered = new Set<unknown>();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const message = isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user") return [];
		if (message.role === "toolResult") answered.add(message.toolCallId);
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted" || !Array.isArray(message.content))
			return [];
		return message.content.flatMap((part) =>
			isRecord(part) && part.type === "toolCall" && !answered.has(part.id)
				? [`${String(part.name)}(${shownLine(JSON.stringify(part.arguments ?? {}), CALL_CHARS)})`]
				: [],
		);
	}
	return [];
}

/**
 * One item per line part: what runs and why, then where its output is: `bash-3 (`yarn test`, why "…", log ~/…/bash-3-….log)`,
 * `general-ab12 (goal "…", why "…", transcript folder ~/…)` or, without a goal, `(task "…")`. A log that is gone (the
 * retention sweep removed it) is not offered.
 */
export function describeWork(work: BackgroundWork, checkLog = true): string {
	const why = work.why ? `, why "${work.why}"` : "";
	if (work.kind === "agent")
		return `${work.id} (${work.goal ? "goal" : "task"} "${work.label}"${why}${describeFiles(work.files ?? {})})`;
	const log = work.log ? (!checkLog || fs.existsSync(work.log) ? `, log ${tildePath(work.log)}` : ", log deleted") : "";
	return `${work.id} (\`${work.label}\`${why}${log})`;
}
