import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import type { WorkspaceEvent, WorkspaceSnapshot } from "@octocodeai/octocode-contacts/workspace";

/** A feed event; tool events may carry a short argument label from the host. */
export type FeedEvent = WorkspaceEvent & { hint?: string };

export type Tone = "success" | "danger" | "tool" | "agent" | "neutral";
interface ActivityCard {
	tone: Tone;
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
};
const FAILED_STATUSES = ["failed", "error", "blocked"];

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A detail that reads as text; an object or array has no readable string form. */
function scalarText(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: undefined;
}

function isFailed(event: WorkspaceEvent): boolean {
	return event.outcome === "failed" || FAILED_STATUSES.includes(String(record(event.details).status));
}

/** How one feed event reads: agent results use their structured summary; tool output splits its first line off as a title. */
export function activityCard(event: FeedEvent): ActivityCard {
	const details = record(event.details);
	const failed = isFailed(event);
	const structured = event.type === "agent.result";
	const prose = event.type === "message" || event.type === "agent.progress";
	const [firstLine, ...rest] = event.type.startsWith("tool.") ? toolHeadline(event) : event.text.split("\n");
	const hint = event.type.startsWith("tool.") ? hintOf(event) : "";
	return {
		failed,
		tone: failed
			? "danger"
			: event.type.endsWith(".result")
				? "success"
				: event.type.startsWith("tool.")
					? "tool"
					: event.type.startsWith("agent.")
						? "agent"
						: "neutral",
		label: failed ? "Needs attention" : (LABELS[event.type] ?? event.type),
		status: scalarText(details.status),
		title: prose
			? event.type === "message"
				? "Agent message"
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
 * Projects streamed assistant messages and tool calls into feed events. Ids are negative so they never collide with
 * stored workspace events, and each keeps the time it was first seen so streaming text does not reorder the feed.
 */
export class ApplicationProjection {
	/** The current run and when this view first saw it; undefined while the session is idle. */
	run: { id: string; startedAt: number } | undefined;
	private answered = false;
	private sessionId: string | undefined;
	private readonly messages = new Map<string, WorkspaceEvent>();
	private readonly tools = new Map<string, WorkspaceEvent>();
	private nextId = -1;

	update(snapshot: ApplicationSnapshot | undefined, at: number): WorkspaceEvent[] {
		if (snapshot?.sessionId !== this.sessionId) {
			this.messages.clear();
			this.tools.clear();
			this.sessionId = snapshot?.sessionId;
			this.run = undefined;
		}
		const runId = snapshot?.streaming ? snapshot.runId : undefined;
		if (runId !== this.run?.id) {
			this.run = runId ? { id: runId, startedAt: at } : undefined;
			this.answered = false;
		}
		const messages = new Map<string, WorkspaceEvent>();
		for (const message of snapshot?.messages ?? []) {
			if (message.role !== "assistant") continue;
			const text = visibleText(message.text);
			// A turn that only called tools or only thought has nothing to read; its tools appear as their own events.
			if (!text.trim()) continue;
			const previous = this.messages.get(message.id);
			const status = message.complete ? "completed" : "streaming";
			const unchanged = previous && previous.text === text && statusOf(previous) === status;
			// The first answer of a run records how long the run thought before it; later updates keep that figure.
			let thoughtMs = record(previous?.details).thoughtMs as number | undefined;
			if (!previous && this.run && !this.answered) {
				thoughtMs = at - this.run.startedAt;
				this.answered = true;
			}
			messages.set(
				message.id,
				unchanged
					? previous
					: {
							id: previous?.id ?? this.nextId--,
							at: previous?.at ?? at,
							type: "message",
							text,
							details: { messageId: message.id, status, ...(thoughtMs !== undefined ? { thoughtMs } : {}) },
						},
			);
		}
		const tools = new Map<string, WorkspaceEvent>();
		for (const tool of snapshot?.tools ?? []) {
			const previous = this.tools.get(tool.toolCallId);
			const text = `${tool.toolName}\n${tool.text}`;
			const unchanged =
				previous &&
				previous.text === text &&
				statusOf(previous) === tool.status &&
				(previous as FeedEvent).hint === tool.hint;
			tools.set(
				tool.toolCallId,
				unchanged
					? previous
					: {
							id: previous?.id ?? this.nextId--,
							at: previous?.at ?? at,
							type: tool.status === "running" ? "tool.start" : "tool.result",
							text,
							...(tool.hint ? { hint: tool.hint } : {}),
							outcome: tool.status === "failed" ? "failed" : undefined,
							details: { toolCallId: tool.toolCallId, status: tool.status },
						},
			);
		}
		this.replace(this.messages, messages);
		this.replace(this.tools, tools);
		// Items new in one snapshot share its time, so the feed's time sort keeps this order: the host's, when it sent one.
		const ordered = [
			...(snapshot?.messages ?? []).map((message) => ({ event: messages.get(message.id), order: message.order })),
			...(snapshot?.tools ?? []).map((tool) => ({ event: tools.get(tool.toolCallId), order: tool.order })),
		];
		return ordered
			.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
			.flatMap(({ event }) => (event ? [event] : []));
	}

	private replace(target: Map<string, WorkspaceEvent>, source: Map<string, WorkspaceEvent>): void {
		target.clear();
		for (const [key, value] of source) target.set(key, value);
	}
}

function statusOf(event: WorkspaceEvent): unknown {
	return record(event.details).status;
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
			const json = JSON.stringify(event);
			const previous = this.known.get(event.id);
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
}
const isTool = (event: WorkspaceEvent) => event.type.startsWith("tool.");

/** Runs of two or more consecutive tool events collapse into one group, keyed by its first event. */
export function groupFeed(events: readonly WorkspaceEvent[]): FeedEntry[] {
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
				summary: { total: run.length, running, failed: run.filter(isFailed).length, done: run.length - running },
			});
			i = end;
		} else {
			entries.push({ kind: "event", event: events[i] });
			i++;
		}
	}
	return entries;
}

/**
 * The host writes `[Tool call: name]` for tool-call blocks and `[Content available in the session]` for other hidden
 * blocks such as thinking (core/application/service.ts). Tool calls already appear as tool events, so both placeholders
 * are removed; the image placeholder stays because it tells the reader something is missing.
 */
const HIDDEN_PLACEHOLDERS = /\[Tool call: [^\]\n]*\]|\[Content available in the session\]/g;
function visibleText(text: string): string {
	return text.replace(HIDDEN_PLACEHOLDERS, "");
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

export type RunPhase = { kind: "idle" } | { kind: "thinking" } | { kind: "writing" } | { kind: "tool"; name: string };
/** What a run is doing now: a running tool wins, then a partial answer, otherwise the model is still thinking. */
export function runPhase(snapshot: ApplicationSnapshot | undefined): RunPhase {
	if (!snapshot?.streaming) return { kind: "idle" };
	const tool = snapshot.tools?.findLast((candidate) => candidate.status === "running");
	if (tool) return { kind: "tool", name: tool.toolName };
	const last = snapshot.messages.at(-1);
	if (last?.role === "assistant" && !last.complete && last.text) return { kind: "writing" };
	return { kind: "thinking" };
}

// The ESC that starts a terminal colour code, then its parameters and final letter.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

export interface TerminalEntry {
	id: number;
	at: number;
	command: string;
	output: string;
	status: "running" | "done" | "failed";
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
			status: isFailed(event) ? "failed" : event.type === "tool.start" ? "running" : "done",
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
	const hint = event.hint ?? record(event.details).hint;
	return typeof hint === "string" ? hint : "";
}

const fromWorkspacePath = (event: WorkspaceEvent) => !("toolCallId" in record(event.details));
/**
 * The workspace path publishes a call's start and result as two events with no shared id. Each result settles the
 * oldest unsettled start of the same tool, and settled starts are dropped, so a finished call appears once and only
 * calls still running show as running. Application-path tool events are one event per call and are left alone.
 */
export function settleToolStarts(events: readonly FeedEvent[]): FeedEvent[] {
	const open = new Map<string, number[]>();
	const settledBy = new Map<number, number>();
	for (const [position, event] of events.entries()) {
		if (!fromWorkspacePath(event)) continue;
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
		const id = record(event.details).id;
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
/** Unified diffs from the file tool's per-query outcomes (workspace path only: the application stream has no details). */
export function fileDiffs(details: unknown): FileDiff[] {
	const outcomes = record(details).outcomes;
	if (!Array.isArray(outcomes)) return [];
	return outcomes.flatMap((outcome) => {
		const entry = record(outcome);
		return entry.ok === true && typeof entry.diff === "string" && entry.diff
			? [{ path: scalarText(entry.path) ?? "", type: scalarText(entry.type) ?? "edit", diff: entry.diff }]
			: [];
	});
}
