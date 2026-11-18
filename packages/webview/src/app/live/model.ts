import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { WorkspaceEvent, WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { stripTerminalSequences } from "@octocodeai/octocode-common/ansi";
import type { UiState } from "../model/ui-state.ts";
import type { FeedEvent } from "./application-projection.ts";
import { type JobPhase, jobPhaseOf, jobWords } from "./phase-words.ts";
export { ApplicationProjection, type FeedEvent } from "./application-projection.ts";

export type Tone = "success" | "danger" | "accent" | "warning" | "agent" | "neutral";
interface ActivityCard {
	tone: Tone;
	/** The run-state shape beside the label; absent for events that are not a state (requests, session notes). */
	ui?: UiState;
	label: string;
	status?: string;
	title: string;
	goal?: string;
	body: string;
	files: string[];
	failed: boolean;
	/** How long the run thought before this answer, on the first answer of a run. */
	thoughtMs?: number;
	/** Whether the body is Markdown to render (messages, reports) rather than literal tool output. */
	markdown: boolean;
}

const LABELS: Record<string, string> = {
	"tool.start": "Tool started",
	"tool.result": "Tool result",
	"agent.start": "Agent started",
	"agent.progress": "Agent progress",
	"agent.result": "Agent result",
	"agent.settled": "Agent settled",
	command: "Request",
	message: "Message",
	session: "Session",
	"session.activity": "Session update",
};
const FAILED_STATUSES = ["failed", "error", "blocked"];

/** A detail that reads as text; an object or array has no readable string form. */
function scalarText(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: undefined;
}

/** A tool whose model response failed before it ran: neither a success nor a failure of its own. */
function isNotRun(event: WorkspaceEvent): boolean {
	return asRecord(event.details).status === "not_run";
}

function isFailed(event: WorkspaceEvent): boolean {
	return event.outcome === "failed" || FAILED_STATUSES.includes(String(asRecord(event.details).status));
}

/** A reply the user cut short or the run abandoned: stopped, not a failure and not a normal answer. */
function isStopped(event: WorkspaceEvent): boolean {
	return event.type === "message" && ["aborted", "interrupted"].includes(String(asRecord(event.details).status));
}

/** The shape a card shows: running until its result arrives, then done, failed or stopped. */
function cardState(
	event: WorkspaceEvent,
	{ failed, notRun, stopped }: { failed: boolean; notRun: boolean; stopped: boolean },
): UiState | undefined {
	if (failed) return "failed";
	if (notRun || stopped) return "stopped";
	if (asRecord(event.details).status === "streaming") return "running";
	if (event.type === "tool.start" || event.type === "agent.start" || event.type === "agent.progress") return "running";
	return event.type.endsWith(".result") || event.type === "agent.settled" ? "done" : undefined;
}

/** How one feed event reads: agent results use their structured summary; tool output splits its first line off as a title. */
export function activityCard(event: FeedEvent): ActivityCard {
	const details = asRecord(event.details);
	const failed = isFailed(event);
	const notRun = isNotRun(event);
	const stopped = isStopped(event);
	const structured = event.type === "agent.result";
	const prose = event.type === "message" || event.type === "agent.progress";
	const [firstLine, ...rest] = event.type.startsWith("tool.") ? toolHeadline(event) : event.text.split("\n");
	const hint = event.type.startsWith("tool.") ? hintOf(event) : "";
	const ui = cardState(event, { failed, notRun, stopped });
	return {
		failed,
		...(ui ? { ui } : {}),
		tone: failed
			? "danger"
			: stopped
				? "warning"
				: notRun
					? "neutral"
					: event.type.endsWith(".result")
						? "success"
						: event.type.startsWith("tool.")
							? "accent"
							: event.type.startsWith("agent.")
								? "agent"
								: "neutral",
		label: failed ? "Needs attention" : notRun ? "Not run" : stopped ? "Stopped" : (LABELS[event.type] ?? event.type),
		status: notRun ? "not run" : scalarText(details.status),
		title: prose
			? event.type === "message"
				? event.message?.role === "user"
					? "You"
					: event.message?.role && event.message.role !== "assistant"
						? event.message.role
						: "Agent message"
				: "Progress update"
			: structured
				? scalarText(details.summary) || "Agent result"
				: hint
					? `${firstLine} ${hint}`
					: firstLine,
		goal: details.goal ? scalarText(details.goal) : undefined,
		body: prose ? event.text : structured ? (scalarText(details.body) ?? "") : rest.join("\n"),
		files: structured && Array.isArray(details.files) ? details.files.map(String) : [],
		thoughtMs: typeof details.thoughtMs === "number" ? details.thoughtMs : undefined,
		// A subagent's report is the agent tool's output: Markdown, like any other answer.
		markdown: !event.type.startsWith("tool.") || firstLine === "agent",
	};
}

/**
 * Snapshots arrive as fresh JSON, so every event is a new object. Reusing the previous object for an unchanged event
 * lets memoized feed rows skip rendering: a new event or a streaming delta re-renders one row, not the whole feed.
 */
export class EventInterner {
	private known = new Map<number, { json: string; event: WorkspaceEvent }>();

	intern(events: readonly WorkspaceEvent[]): WorkspaceEvent[] {
		const next = new Map<number, { json: string; event: WorkspaceEvent }>();
		const result = events.map((event) => {
			const previous = this.known.get(event.id);
			// The projection keeps unchanged rows identical, so only new or changed objects are serialized.
			if (previous?.event === event) {
				next.set(event.id, previous);
				return event;
			}
			const json = JSON.stringify(event);
			const entry = previous?.json === json ? previous : { json, event };
			next.set(event.id, entry);
			return entry.event;
		});
		this.known = next;
		return result;
	}
}

export type FeedEntry =
	| { kind: "event"; event: WorkspaceEvent }
	| { kind: "tools"; id: number; events: WorkspaceEvent[]; summary: ToolSummary };
interface ToolSummary {
	total: number;
	running: number;
	failed: number;
	done: number;
	notRun: number;
}
const isTool = (event: WorkspaceEvent) => event.type.startsWith("tool.");

/** Runs of two or more consecutive tool events collapse into one group, keyed by its first event. */
export function groupFeed(source: readonly FeedEvent[], showEmbedded = false): FeedEntry[] {
	const events = showEmbedded ? source : source.filter((event) => !event.embedded);
	const entries: FeedEntry[] = [];
	for (let i = 0; i < events.length;) {
		let end = i;
		while (end < events.length && isTool(events[end])) end++;
		if (end - i >= 2) {
			const run = events.slice(i, end);
			const running = run.filter((event) => event.type === "tool.start").length;
			entries.push({
				kind: "tools",
				id: run[0].id,
				events: run,
				summary: {
					total: run.length,
					running,
					failed: run.filter(isFailed).length,
					done: run.length - running,
					notRun: run.filter(isNotRun).length,
				},
			});
			i = end;
		} else {
			entries.push({ kind: "event", event: events[i] });
			i++;
		}
	}
	return entries;
}

export const EVENT_LIMIT = 200;
export function mergeEvents(
	domain: WorkspaceSnapshot,
	application: readonly WorkspaceEvent[],
	applicationSessionId: string | undefined,
): WorkspaceSnapshot {
	const extra = applicationSessionId === domain.sessionId ? application : [];
	return { ...domain, events: [...domain.events, ...extra].sort((a, b) => a.at - b.at).slice(-EVENT_LIMIT) };
}

export type ConnectionTone = "live" | "connecting" | "error";
/** The transport reports status as text; recoverable states mention reconnecting or refreshing. */
export function connectionTone(message: string): ConnectionTone {
	return /reconnecting|refreshing|connecting/i.test(message) ? "connecting" : "error";
}

export type RunPhase =
	| { kind: "idle" }
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "tool"; name: string }
	| { kind: "compacting" }
	| { kind: "retrying" }
	| { kind: "waiting"; awaiting: NonNullable<ApplicationSnapshot["awaiting"]> }
	/** No run is active but the job goes on: background agents, a pending wake, or a timer. */
	| { kind: "job"; phase: JobPhase };
/**
 * What the session is doing now. A dialog that waits for the user wins (also while no run is active: a background
 * subagent's approval), then compaction or a retry (which start after the run settled, so `streaming` is already
 * false), then a running tool, a partial answer, and last the model still thinking.
 */
export function runPhase(snapshot: ApplicationSnapshot | undefined): RunPhase {
	if (snapshot?.awaiting) return { kind: "waiting", awaiting: snapshot.awaiting };
	if (snapshot?.status === "compacting" || snapshot?.status === "retrying") return { kind: snapshot.status };
	if (!snapshot?.streaming) {
		// The run settled but the host says the job did not end: not idle, and not finished.
		const job = jobPhaseOf(snapshot?.phase);
		return job ? { kind: "job", phase: job } : { kind: "idle" };
	}
	const tool = snapshot.tools?.findLast((candidate) => candidate.status === "running");
	if (tool) return { kind: "tool", name: tool.toolName };
	const last = snapshot.messages.at(-1);
	if (last?.role === "assistant" && !last.complete && last.text) return { kind: "writing" };
	return { kind: "thinking" };
}

/** The session panel's badge: the shared run state and its label, or nothing while the session is idle. */
export function sessionBadge(
	snapshot: Pick<ApplicationSnapshot, "streaming" | "status" | "awaiting" | "phase"> | undefined,
): { state: UiState; label: string; warn: boolean } | undefined {
	if (snapshot?.awaiting) return { state: "waiting", label: "Waiting for you", warn: true };
	if (snapshot?.status === "compacting") return { state: "running", label: "Compacting", warn: false };
	if (snapshot?.status === "retrying") return { state: "running", label: "Retrying", warn: true };
	if (snapshot?.streaming) return { state: "running", label: "Running", warn: false };
	const job = jobPhaseOf(snapshot?.phase);
	return job ? { state: "running", label: jobWords(job, Date.now()), warn: false } : undefined;
}

export const stripAnsi = stripTerminalSequences;

export interface TerminalEntry {
	id: number;
	at: number;
	command: string;
	output: string;
	status: "running" | "done" | "failed" | "not run";
}
/** Tool events as a chronological transcript: the first line names the command, the rest is its output. */
export function terminalEntries(events: readonly FeedEvent[]): TerminalEntry[] {
	return events.filter(isTool).map((event) => {
		const [name, ...output] = toolHeadline(event);
		const hint = hintOf(event);
		return {
			id: event.id,
			at: event.at,
			command: hint ? `${name} ${hint}` : name,
			output: output.join("\n"),
			status: isFailed(event)
				? "failed"
				: isNotRun(event)
					? "not run"
					: event.type === "tool.start"
						? "running"
						: "done",
		};
	});
}

/**
 * A tool event's lines with colour codes removed: the tool name first, then its output. The workspace path appends
 * " failed" to the name of a failed call; the outcome already says so.
 */
function toolHeadline(event: WorkspaceEvent): string[] {
	// Output usually ends with a newline; trailing whitespace would render as blank lines.
	const [name = "", ...lines] = stripAnsi(event.text).trimEnd().split("\n");
	return [displayToolName(event.outcome === "failed" ? name.replace(/ failed$/, "") : name), ...lines];
}

/** MCP tools are registered as `mcp__<server>__<tool>`; the host labels them `server/tool`, and so does the feed. */
function displayToolName(name: string): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	return mcp ? `${mcp[1]}/${mcp[2]}` : name;
}

/** The host's argument label: on the event itself, or in a workspace-path start's details. */
function hintOf(event: FeedEvent): string {
	const hint = event.hint ?? asRecord(event.details).hint;
	return typeof hint === "string" ? hint : "";
}

const fromWorkspacePath = (event: WorkspaceEvent) => !("toolCallId" in asRecord(event.details));
/**
 * The workspace path publishes a call's start and result as two events with no shared id. Each result settles the
 * oldest unsettled start of the same tool, and settled starts are dropped, so a finished call appears once and only
 * calls still running show as running. Application-path tool events are one event per call and are left alone.
 */
export function settleToolStarts(events: readonly FeedEvent[]): FeedEvent[] {
	const open = new Map<string, number[]>();
	const settledBy = new Map<number, number>();
	for (const [position, event] of events.entries()) {
		if ((event.type !== "tool.start" && event.type !== "tool.result") || !fromWorkspacePath(event)) continue;
		const name = toolHeadline(event)[0];
		if (event.type === "tool.start") open.set(name, [...(open.get(name) ?? []), position]);
		else if (event.type === "tool.result") {
			const start = open.get(name)?.shift();
			if (start !== undefined) settledBy.set(start, position);
		}
	}
	if (!settledBy.size) return [...events];
	const hints = new Map([...settledBy].map(([start, result]) => [result, hintOf(events[start])]));
	return events.flatMap((event, position) => {
		if (settledBy.has(position)) return [];
		const hint = hints.get(position);
		return hint ? [{ ...event, hint }] : [event];
	});
}

/**
 * The agent tool reports progress on every usage, thinking and tool step, and the workspace path stores each report as
 * a new event. Only the latest report per agent says anything current, so earlier ones are dropped.
 */
export function latestProgress(events: readonly WorkspaceEvent[]): WorkspaceEvent[] {
	const keyOf = (event: WorkspaceEvent) => {
		const id = asRecord(event.details).id;
		return typeof id === "string" ? id : "";
	};
	const latest = new Map<string, number>();
	for (const event of events) if (event.type === "agent.progress") latest.set(keyOf(event), event.id);
	if (!latest.size) return [...events];
	return events.filter((event) => event.type !== "agent.progress" || latest.get(keyOf(event)) === event.id);
}

export interface FileDiff {
	path: string;
	type: string;
	diff: string;
}
