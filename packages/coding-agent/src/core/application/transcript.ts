import { createHash } from "node:crypto";
import type {
	ApplicationEvent,
	ApplicationHistory,
	ApplicationMessage,
	ApplicationTool,
} from "@octocodeai/octocode-contacts";
import type { AgentSessionEvent } from "../agent-session.ts";
import { stoppedToolText } from "./interrupted-tools.ts";
import { toolHint } from "../../octocode/shared/util.ts";
import { ApplicationAssets } from "./assets.ts";
import type { ApplicationStateStore } from "./state.ts";
import { ApplicationCollection } from "./collection.ts";
import {
	cloneDisplay,
	normalizeApplicationContent,
	normalizeApplicationMessage,
	normalizeToolData,
	record,
} from "./normalize.ts";
import { keepEnds, OUTPUT_CHARS, toolResultText } from "./service/projection.ts";
import { sameMessage, transcriptHistory } from "./transcript-history.ts";
import type { ToolOutputProjector } from "./service/types.ts";

type MessageEvent = Extract<AgentSessionEvent, { type: "message_start" | "message_end" | "message_update" }>;
type ToolEvent = Extract<
	AgentSessionEvent,
	{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

/** Ordered, interface-independent conversation state. Only snapshots are windowed; history remains queryable. */
export class ApplicationTranscript {
	readonly assets = new ApplicationAssets();
	private readonly messageEntries: ApplicationCollection<ApplicationMessage>;
	private readonly toolEntries: ApplicationCollection<ApplicationTool>;
	constructor(state: ApplicationStateStore) {
		this.messageEntries = new ApplicationCollection(
			() => state.getState().messages,
			(messages) => state.setState({ messages }),
		);
		this.toolEntries = new ApplicationCollection(
			() => state.getState().tools,
			(tools) => state.setState({ tools }),
		);
	}
	get messages(): ReadonlyMap<string, ApplicationMessage> {
		return this.messageEntries.values;
	}
	get tools(): ReadonlyMap<string, ApplicationTool> {
		return this.toolEntries.values;
	}
	private putMessage(id: string, message: ApplicationMessage): void {
		this.messageEntries.set(id, message);
	}
	private putTool(id: string, tool: ApplicationTool): void {
		this.toolEntries.set(id, tool);
	}
	batch(work: () => void): void {
		this.messageEntries.batch(() => this.toolEntries.batch(work));
	}
	private identities = new WeakMap<object, string>();
	private sources = new Map<string, unknown>();
	private toolSources = new Map<string, { value: unknown; owner: string; streaming: boolean }>();
	private activeMessage?: string;
	private nextOrder = 0;
	private nextMessage = 0;
	private projector?: { project: ToolOutputProjector; active: boolean; previous?: ApplicationTranscript["projector"] };

	setProjector(project: ToolOutputProjector, changed: () => void): () => void {
		const registration = { project, active: true, previous: this.projector };
		this.projector = registration;
		this.reproject();
		changed();
		return () => {
			registration.active = false;
			if (this.projector !== registration) return;
			let previous = registration.previous;
			while (previous && !previous.active) previous = previous.previous;
			this.projector = previous;
			this.reproject();
			changed();
		};
	}

	private projected(owner: string, value: unknown): string | undefined {
		try {
			return this.projector?.project(owner, value);
		} catch {
			return "Tool output unavailable";
		}
	}
	private reproject(): void {
		this.batch(() => {
			for (const [id, source] of this.sources) {
				const previous = this.messages.get(id)!;
				const value = previous.complete ? source : { ...record(source), stopReason: "pending" };
				this.putMessage(id, {
					...this.normalize(value, id),
					complete: previous.complete,
					status: previous.status,
					order: previous.order,
				});
			}
			for (const [id, tool] of this.tools) {
				const source = this.toolSources.get(id);
				if (source) this.putTool(id, { ...tool, ...this.toolData(source.value, id, source.owner, source.streaming) });
			}
		});
	}

	normalize(value: unknown, id?: string): ApplicationMessage {
		const source = record(value);
		id ??= this.identities.get(source);
		if (!id) {
			const identity = [source.role, source.timestamp, source.toolCallId, this.nextMessage++];
			id = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
			this.identities.set(source, id);
		}
		const owner =
			source.role === "toolResult" ? source.toolName : source.role === "custom" ? source.customType : undefined;
		const projected = typeof owner === "string" ? this.projected(owner, value) : undefined;
		const normalized = normalizeApplicationMessage(source, id, this.assets);
		if (projected === undefined) return normalized;
		return {
			...normalizeApplicationMessage({ ...source, content: projected }, id, this.assets),
			full: this.assets.put(
				JSON.stringify(normalized),
				"application/json",
				"utf8",
				undefined,
				source.stopReason === "pending" ? `${id}:projection` : undefined,
			),
		};
	}
	/** A display failure does not rewrite the model's outcome or discard the original session message. */
	unavailable(value: unknown, id?: string): ApplicationMessage {
		const source = record(value);
		return this.normalize(
			{
				role: typeof source.role === "string" ? source.role.slice(0, 128) : "custom",
				stopReason: source.stopReason,
				display: source.display === true,
				content: [
					{
						type: "unsupported",
						providerType: "content-unavailable",
						text: "Content could not be displayed; the original remains in the session.",
					},
				],
			},
			id ?? this.identities.get(source),
		);
	}

	message(event: MessageEvent, publish: (event: ApplicationEvent) => void | boolean): void {
		const source = event.message;
		let id = this.identities.get(source) ?? (source.role === "assistant" ? this.activeMessage : undefined);
		id ??= this.normalize(source).id;
		this.identities.set(source, id);
		const previous = this.messages.get(id);
		if (event.type === "message_update" && !previous) {
			const started: ApplicationMessage = {
				id,
				role: source.role,
				text: "",
				content: [],
				complete: false,
				status: "streaming",
				order: this.nextOrder++,
			};
			this.putMessage(id, started);
			if (publish({ type: "message.started", message: started }) === false) return;
		}
		const complete = event.type === "message_end";
		const message = this.normalize(complete ? source : { ...source, stopReason: "pending" }, id);
		message.complete = complete;
		if (!complete) message.status = "streaming";
		message.order = this.messages.get(id)?.order ?? this.nextOrder++;
		// Legacy emitters can deliver text deltas without a partial message body.
		if (
			event.type === "message_update" &&
			!Array.isArray(record(source).content) &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			const text = (previous?.text ?? "") + event.assistantMessageEvent.delta;
			Object.assign(message, this.normalize({ ...source, content: text, stopReason: "pending" }, id));
		}
		this.putMessage(id, message);
		this.sources.set(id, source);
		if (source.role === "assistant") this.activeMessage = complete ? undefined : id;
		if (complete) this.restoreTools(message, source);
		if (event.type === "message_update") {
			if (
				event.assistantMessageEvent.type !== "text_delta" &&
				JSON.stringify(previous?.content) === JSON.stringify(message.content) &&
				JSON.stringify(previous?.full) === JSON.stringify(message.full) &&
				previous?.text === message.text
			)
				return;
			publish({
				type: "message.delta",
				messageId: id,
				delta: event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta.slice(-64000) : "",
				text: message.text,
				content: message.content,
				full: message.full,
			});
		} else publish({ type: complete ? "message.completed" : "message.started", message });
	}

	private restoreTools(message: ApplicationMessage, value: unknown): void {
		const source = record(value);
		const calls = Array.isArray(source.content)
			? source.content.filter((block) => record(block).type === "toolCall")
			: [];
		for (const block of normalizeApplicationContent(calls, message.id, this.assets))
			if (block.type === "toolCall") {
				const previous = this.tools.get(block.toolCallId);
				const finished = previous?.status === "completed" || previous?.status === "failed";
				const stopText = finished
					? undefined
					: stoppedToolText(typeof source.stopReason === "string" ? source.stopReason : undefined, 0);
				this.acceptTool({
					type: finished || stopText !== undefined ? "tool.completed" : "tool.started",
					failed: previous?.status === "failed" || stopText !== undefined,
					...(stopText === undefined ? {} : { text: stopText }),
					...(stopText !== undefined && source.stopReason === "error" ? { notRun: true as const } : {}),
					toolCallId: block.toolCallId,
					toolName: block.name,
					arguments: block.arguments,
					messageId: message.id,
				});
			}
		if (source.role === "toolResult" && typeof source.toolCallId === "string") {
			this.acceptTool({
				type: "tool.completed",
				toolCallId: source.toolCallId,
				toolName: typeof source.toolName === "string" ? source.toolName : "unknown",
				failed: source.isError === true,
				...this.toolData(value, source.toolCallId, typeof source.toolName === "string" ? source.toolName : "unknown"),
			});
		}
	}

	private toolData(value: unknown, id: string, owner: string, streaming = false): Partial<ApplicationTool> {
		this.toolSources.set(id, { value, owner, streaming });
		const projected = this.projected(owner, value);
		const source = projected === undefined ? value : { ...record(value), content: projected };
		const data = {
			...normalizeToolData(source, `tool:${id}`, this.assets, streaming),
			text: projected === undefined ? toolResultText(value) : keepEnds(projected, OUTPUT_CHARS),
		};
		if (projected !== undefined)
			data.full = this.assets.put(
				JSON.stringify(normalizeToolData(value, `tool:${id}`, this.assets, streaming)),
				"application/json",
				"utf8",
				undefined,
				streaming ? `tool:${id}:projection` : undefined,
			);
		if (JSON.stringify(data).length > 60000) {
			data.full = this.assets.put(
				JSON.stringify(data),
				"application/json",
				"utf8",
				undefined,
				streaming ? `tool:${id}:full` : undefined,
			);
			data.content = [
				{
					id: `tool:${id}:full`,
					type: "unsupported",
					providerType: "large-tool-result",
					text: "Full tool result available",
				},
			];
			data.text = "[Full tool result available]";
			delete data.usage;
			delete data.details;
			delete data.structuredContent;
		}
		return data;
	}
	tool(event: ToolEvent): ApplicationEvent {
		return {
			type:
				event.type === "tool_execution_start"
					? "tool.started"
					: event.type === "tool_execution_update"
						? "tool.progress"
						: "tool.completed",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			...(event.type === "tool_execution_start"
				? {
						arguments: cloneDisplay(event.args),
						hint: toolHint(event.args),
						...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
					}
				: {}),
			...(event.type === "tool_execution_end"
				? {
						...this.toolData(event.result, event.toolCallId, event.toolName),
						failed: event.isError,
						...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
					}
				: event.type === "tool_execution_update"
					? this.toolData(event.partialResult, event.toolCallId, event.toolName, true)
					: {}),
		};
	}
	acceptTool(
		event: Extract<ApplicationEvent, { type: "tool.started" | "tool.progress" | "tool.completed" }>,
	): typeof event {
		const previous = this.tools.get(event.toolCallId);
		let storedArguments = previous?.arguments;
		if (storedArguments === undefined && previous?.full && event.full) {
			const full = this.assets.get(previous.full.id);
			if (full?.encoding === "utf8" && full.asset.mimeType === "application/json")
				storedArguments = record(JSON.parse(full.data)).arguments;
		}
		const { type, failed, ...data } = event;
		const tool: ApplicationTool = {
			...previous,
			...(storedArguments === undefined ? {} : { arguments: storedArguments }),
			...data,
			order: previous?.order ?? this.nextOrder++,
			text: event.text ?? previous?.text ?? "",
			notRun: event.notRun,
			status: type === "tool.completed" ? (failed ? "failed" : "completed") : "running",
		};
		if (JSON.stringify(tool).length > 60000) {
			tool.full = this.assets.put(
				JSON.stringify(tool),
				"application/json",
				"utf8",
				undefined,
				type === "tool.completed" ? undefined : `tool:${tool.toolCallId}:state`,
			);
			tool.arguments = undefined;
			tool.details = undefined;
			tool.structuredContent = undefined;
			tool.usage = undefined;
			tool.content = [
				{
					id: `tool:${tool.toolCallId}:full`,
					type: "unsupported",
					providerType: "large-tool-result",
					text: "Full tool data available",
				},
			];
			tool.text = "[Full tool data available]";
		}
		this.putTool(event.toolCallId, tool);
		return { ...tool, type: event.type, ...(event.failed === undefined ? {} : { failed: event.failed }) };
	}

	history(options: { before?: string; limit?: number } = {}): ApplicationHistory {
		return transcriptHistory(this.messages, this.tools, options);
	}
	/**
	 * Take over a rebuilt context array whose messages equal `previous`: keep their ids and displayed state, so views
	 * need no reset. False when any message differs.
	 */
	adopt(previous: readonly unknown[], next: readonly unknown[]): boolean {
		if (previous.length !== next.length || !previous.every((message, index) => sameMessage(message, next[index])))
			return false;
		for (const [index, message] of next.entries()) {
			const id = this.identities.get(record(previous[index]));
			if (id === undefined || message === previous[index]) continue;
			this.identities.set(record(message), id);
			if (this.sources.has(id)) this.sources.set(id, message);
		}
		return true;
	}

	window(): { messages: ApplicationMessage[]; tools: ApplicationTool[] } {
		const tail = <T>(values: Iterable<T>, bytes: number): T[] => {
			const result = [...values].slice(-50);
			while (result.length > 1 && JSON.stringify(result).length > bytes) result.shift();
			return result;
		};
		return cloneDisplay({ messages: tail(this.messages.values(), 100000), tools: tail(this.tools.values(), 50000) });
	}
	clear(): void {
		this.assets.clear();
		this.messageEntries.clear();
		this.toolEntries.clear();
		this.sources.clear();
		this.toolSources.clear();
		this.identities = new WeakMap();
		this.activeMessage = undefined;
		this.nextOrder = 0;
		this.nextMessage = 0;
	}
}
