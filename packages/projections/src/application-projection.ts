import {
	APPLICATION_NOTICE_KIND,
	type ApplicationActivity,
	type ApplicationMessage,
	type ApplicationSnapshot,
	type ApplicationTool,
} from "@octocodeai/octocode-contracts";
import type { WorkspaceEvent } from "@octocodeai/octocode-contracts/workspace";
import { applicationMessageDisplayed } from "./selectors.ts";

/** View metadata retains the shared payload; renderers never reconstruct content from a text preview. */
export type FeedEvent = WorkspaceEvent & {
	hint?: string;
	sessionId?: string;
	message?: ApplicationMessage;
	activity?: ApplicationActivity;
	tool?: ApplicationTool;
	tools?: ApplicationTool[];
	embedded?: boolean;
	thoughtMs?: number;
};

/** Stable row identities and authoritative content for live updates, snapshots and history pages. */
export class ApplicationProjection {
	run: { id: string; startedAt: number } | undefined;
	private answered = false;
	private sessionId: string | undefined;
	private readonly messages = new Map<string, FeedEvent>();
	private readonly tools = new Map<string, FeedEvent>();
	private readonly errors = new Map<string, FeedEvent>();
	private readonly activities = new Map<string, FeedEvent>();
	/**
	 * The source objects each message and tool row was built from. The stream replaces only the message or tool an event
	 * changed, so a row whose sources are the same objects is reused without rebuilding or serializing it: the work per
	 * streamed frame follows the changed row, not the transcript.
	 */
	private readonly sources = new WeakMap<FeedEvent, readonly unknown[]>();
	private nextId = -1;

	update(snapshot: ApplicationSnapshot | undefined, at: number): FeedEvent[] {
		if (snapshot?.sessionId !== this.sessionId) {
			this.messages.clear();
			this.tools.clear();
			this.errors.clear();
			this.activities.clear();
			this.sessionId = snapshot?.sessionId;
			this.run = undefined;
		}
		const runId = snapshot?.streaming ? snapshot.runId : undefined;
		if (runId !== this.run?.id) {
			this.run = runId ? { id: runId, startedAt: at } : undefined;
			this.answered = false;
		}
		const availableTools = snapshot?.tools ?? [];
		const toolIds = new Set(availableTools.map((tool) => tool.toolCallId));
		const toolsById = new Map(availableTools.map((tool) => [tool.toolCallId, tool]));
		const graph = toolGraph(availableTools);
		const linked = new Set<string>();
		const messages = new Map<string, FeedEvent>();
		for (const message of snapshot?.messages ?? []) {
			if (!applicationMessageDisplayed(message)) continue;
			if (message.role === "toolResult" && message.toolCallId !== undefined && toolIds.has(message.toolCallId))
				continue;
			const references = new Set(
				message.content?.flatMap((block) => (block.type === "toolCall" ? [block.toolCallId] : [])),
			);
			const tools = relatedTools(graph, references);
			const sources = [snapshot?.sessionId, message, ...tools];
			const previous = this.messages.get(message.id);
			if (previous && sameSources(this.sources.get(previous), sources)) {
				for (const tool of tools) linked.add(tool.toolCallId);
				messages.set(message.id, previous);
				continue;
			}
			const text = message.content ? message.text : visibleLegacyText(message.text);
			if (!text.trim() && !message.content?.length && !message.errorMessage && !isInterrupted(message.status)) continue;
			for (const tool of tools) linked.add(tool.toolCallId);
			const status = message.status ?? (message.complete ? "completed" : "streaming");
			let thoughtMs = previous?.thoughtMs;
			if (!previous && this.run && !this.answered && message.role === "assistant") {
				thoughtMs = at - this.run.startedAt;
				this.answered = true;
			}
			const next: FeedEvent = {
				id: previous?.id ?? this.nextId--,
				at: previous?.at ?? message.timestamp ?? at,
				type: "message",
				text,
				sessionId: snapshot?.sessionId,
				message,
				...(tools.length ? { tools } : {}),
				...(thoughtMs !== undefined ? { thoughtMs } : {}),
				...(status === "failed" ? { outcome: "failed" } : {}),
				details: {
					messageId: message.id,
					role: message.role,
					status,
					...(thoughtMs !== undefined ? { thoughtMs } : {}),
				},
			};
			messages.set(message.id, this.remember(unchanged(previous, next), sources));
		}
		const tools = new Map<string, FeedEvent>();
		for (const tool of availableTools) {
			const previous = this.tools.get(tool.toolCallId);
			const nested = relatedTools(graph, new Set([tool.toolCallId])).filter(
				(item) => item.toolCallId !== tool.toolCallId,
			);
			const embedded = linked.has(tool.toolCallId) || hasToolParent(tool, toolsById);
			const sources = [snapshot?.sessionId, tool, embedded, ...nested];
			if (previous && sameSources(this.sources.get(previous), sources)) {
				tools.set(tool.toolCallId, previous);
				continue;
			}
			const next: FeedEvent = {
				id: previous?.id ?? this.nextId--,
				at: previous?.at ?? at,
				type: tool.status === "running" ? "tool.start" : "tool.result",
				text: `${tool.toolName}\n${tool.text}`,
				sessionId: snapshot?.sessionId,
				tool,
				...(nested.length ? { tools: nested } : {}),
				...(embedded ? { embedded } : {}),
				...(tool.hint ? { hint: tool.hint } : {}),
				outcome: tool.status === "failed" && !tool.notRun ? "failed" : undefined,
				details: {
					toolCallId: tool.toolCallId,
					status: tool.notRun ? "not_run" : tool.status,
					...(tool.details === undefined ? {} : { result: tool.details }),
				},
			};
			tools.set(tool.toolCallId, this.remember(unchanged(previous, next), sources));
		}
		const errors = new Map<string, FeedEvent>();
		for (const error of snapshot?.errors ?? []) {
			const previous = this.errors.get(error.id);
			errors.set(
				error.id,
				unchanged(previous, {
					id: previous?.id ?? this.nextId--,
					at: previous?.at ?? at,
					type: "application.error",
					text: `Content unavailable\n${error.message}`,
					outcome: "failed",
					details: { status: "failed", code: error.code, errorId: error.id },
				}),
			);
		}
		const activities = new Map<string, FeedEvent>();
		// A notice that repeats a saved line (a memory pass says what it changed, and records it) is that line once.
		const saved = new Set(
			(snapshot?.activities ?? []).flatMap((activity) => (activity.source === "session" ? [activity.text] : [])),
		);
		for (const activity of snapshot?.activities ?? []) {
			if (activity.source === "live" && activity.kind === APPLICATION_NOTICE_KIND && saved.has(activity.text)) continue;
			const previous = this.activities.get(activity.id);
			activities.set(
				activity.id,
				unchanged(previous, {
					id: previous?.id ?? this.nextId--,
					at: activity.at,
					type: "session.activity",
					text: activity.text,
					...(activity.outcome === "failed" ? { outcome: "failed" } : {}),
					sessionId: snapshot?.sessionId,
					activity,
				}),
			);
		}
		this.replace(this.activities, activities);
		this.replace(this.errors, errors);
		this.replace(this.messages, messages);
		this.replace(this.tools, tools);
		return [
			...(snapshot?.messages ?? []).map((message) => ({ event: messages.get(message.id), order: message.order })),
			...availableTools.map((tool) => ({ event: tools.get(tool.toolCallId), order: tool.order })),
		]
			.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
			.flatMap(({ event }) => (event ? [event] : []))
			.concat([...activities.values()], [...errors.values()]);
	}

	private remember(event: FeedEvent, sources: readonly unknown[]): FeedEvent {
		this.sources.set(event, sources);
		return event;
	}

	private replace(target: Map<string, FeedEvent>, source: Map<string, FeedEvent>): void {
		target.clear();
		for (const [key, value] of source) target.set(key, value);
	}
}

function unchanged(previous: FeedEvent | undefined, next: FeedEvent): FeedEvent {
	return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function sameSources(previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
	return previous?.length === next.length && previous.every((value, index) => value === next[index]);
}

function isInterrupted(status: ApplicationMessage["status"]): boolean {
	return status === "failed" || status === "aborted" || status === "interrupted";
}

/** Follow parent ids without recursion so malformed cycles cannot hang a consumer. */
/**
 * Whether a tool hangs under another tool of the snapshot. Malformed parents can form a cycle (a tool its own parent,
 * or two tools each other's): every member would be embedded and the whole group would vanish, so the member with the
 * smallest id stays a root.
 */
function hasToolParent(tool: ApplicationTool, byId: ReadonlyMap<string, ApplicationTool>): boolean {
	const seen = new Set<string>();
	let current = tool;
	for (;;) {
		const parent = current.parentToolCallId === undefined ? undefined : byId.get(current.parentToolCallId);
		if (!parent) return current !== tool;
		seen.add(current.toolCallId);
		// The walk closed a cycle: `tool` is in it only when the walk came back to it.
		if (seen.has(parent.toolCallId)) return parent !== tool || [...seen].some((id) => id < tool.toolCallId);
		current = parent;
	}
}

interface ToolGraph {
	tools: readonly ApplicationTool[];
	/** Indexes of the tools carrying an id. */
	byId: ReadonlyMap<string, number[]>;
	/** Indexes of the tools hanging under a parent id. */
	children: ReadonlyMap<string, number[]>;
}

/** One pass over the tools: every related-tools lookup afterwards follows only its own descendants. */
function toolGraph(tools: readonly ApplicationTool[]): ToolGraph {
	const byId = new Map<string, number[]>();
	const children = new Map<string, number[]>();
	tools.forEach((tool, index) => {
		const same = byId.get(tool.toolCallId);
		if (same) same.push(index);
		else byId.set(tool.toolCallId, [index]);
		if (!tool.parentToolCallId) return;
		const siblings = children.get(tool.parentToolCallId);
		if (siblings) siblings.push(index);
		else children.set(tool.parentToolCallId, [index]);
	});
	return { tools, byId, children };
}

/** The tools with the given ids plus all their descendants, in snapshot order. A seen set keeps parent cycles finite. */
function relatedTools(graph: ToolGraph, ids: ReadonlySet<string>): ApplicationTool[] {
	const found = new Set<number>();
	const seen = new Set<string>();
	const pending = [...ids];
	while (pending.length) {
		const id = pending.pop() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const index of graph.byId.get(id) ?? []) found.add(index);
		for (const index of graph.children.get(id) ?? []) {
			found.add(index);
			pending.push(graph.tools[index].toolCallId);
		}
	}
	return [...found].sort((a, b) => a - b).map((index) => graph.tools[index]);
}

/** Strips the placeholders `applicationContentText` writes into a text-only message. Rich blocks never pass through it. */
function visibleLegacyText(text: string): string {
	return text.replace(/\[Tool call: [^\]\n]*\]|\[Content available in the session\]/g, "");
}
