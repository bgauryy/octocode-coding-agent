import type {
	ApplicationActivity,
	ApplicationMessage,
	ApplicationSnapshot,
	ApplicationTool,
} from "@octocodeai/octocode-contacts";
import type { WorkspaceEvent } from "@octocodeai/octocode-contacts/workspace";

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
		const linked = new Set<string>();
		const messages = new Map<string, FeedEvent>();
		for (const message of snapshot?.messages ?? []) {
			if (message.display === false || (message.role === "custom" && message.display !== true)) continue;
			if (message.role === "toolResult" && availableTools.some((tool) => tool.toolCallId === message.toolCallId))
				continue;
			const text = message.content ? message.text : visibleLegacyText(message.text);
			if (!text.trim() && !message.content?.length && !message.errorMessage && !isInterrupted(message.status)) continue;
			const references = new Set(
				message.content?.flatMap((block) => (block.type === "toolCall" ? [block.toolCallId] : [])) ?? [],
			);
			const tools = relatedTools(availableTools, references);
			for (const tool of tools) linked.add(tool.toolCallId);
			const previous = this.messages.get(message.id);
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
			messages.set(message.id, unchanged(previous, next));
		}
		const tools = new Map<string, FeedEvent>();
		for (const tool of availableTools) {
			const previous = this.tools.get(tool.toolCallId);
			const nested = relatedTools(availableTools, new Set([tool.toolCallId])).filter(
				(item) => item.toolCallId !== tool.toolCallId,
			);
			const embedded =
				linked.has(tool.toolCallId) || availableTools.some((parent) => parent.toolCallId === tool.parentToolCallId);
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
			tools.set(tool.toolCallId, unchanged(previous, next));
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
		for (const activity of snapshot?.activities ?? []) {
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

	private replace(target: Map<string, FeedEvent>, source: Map<string, FeedEvent>): void {
		target.clear();
		for (const [key, value] of source) target.set(key, value);
	}
}

function unchanged(previous: FeedEvent | undefined, next: FeedEvent): FeedEvent {
	return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function isInterrupted(status: ApplicationMessage["status"]): boolean {
	return status === "failed" || status === "aborted" || status === "interrupted";
}

/** Follow parent ids without recursion so malformed cycles cannot hang a consumer. */
function relatedTools(tools: readonly ApplicationTool[], ids: Set<string>): ApplicationTool[] {
	let changed = true;
	while (changed) {
		changed = false;
		for (const tool of tools) {
			if (!ids.has(tool.toolCallId) && tool.parentToolCallId && ids.has(tool.parentToolCallId)) {
				ids.add(tool.toolCallId);
				changed = true;
			}
		}
	}
	return tools.filter((tool) => ids.has(tool.toolCallId));
}

/** Compatibility with hosts that only sent text previews. Rich blocks never pass through placeholder parsing. */
function visibleLegacyText(text: string): string {
	return text.replace(/\[Tool call: [^\]\n]*\]|\[Content available in the session\]/g, "");
}
