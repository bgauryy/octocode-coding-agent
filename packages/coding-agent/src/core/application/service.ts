import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
	ApplicationCommandSchema,
	applicationCommandFingerprint,
	type ApplicationCommand,
	type ApplicationConnection,
	type ApplicationCursor,
	type ApplicationEvent,
	type ApplicationFrame,
	type ApplicationMessage,
	type ApplicationReceipt,
	type ApplicationSnapshot,
	type ApplicationTool,
	type LocalApplicationPort,
	type ApplicationOperation,
	type ApplicationOperationArgs,
	type ApplicationOperationResult,
} from "@octocodeai/octocode-contacts";
import { toolHint } from "../../octocode/shared/util.ts";
import { redactSecrets } from "../../octocode/shared/sanitize.ts";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../agent-session.ts";

/** Characters of tool output a frame carries. */
const OUTPUT_CHARS = 16_000;
const HEAD_CHARS = 4_000;
/**
 * Long output keeps its start (results often open with a summary: a page title, a match count) and its end (where
 * commands report failures), joined by a marker that says how much was left out.
 */
function keepEnds(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = (omitted: number) => `\n… [${omitted} characters omitted] …\n`;
	const tail = max - HEAD_CHARS - marker(text.length).length;
	return `${text.slice(0, HEAD_CHARS)}${marker(text.length - HEAD_CHARS - tail)}${text.slice(-tail)}`;
}

type Method = ApplicationOperation<AgentSession>;
type Args<K extends Method> = ApplicationOperationArgs<AgentSession, K>;
type Result<K extends Method> = ApplicationOperationResult<AgentSession, K>;
const services = new WeakMap<AgentSession, ApplicationService>();
const registered = new Set<ApplicationService>();
export function getApplicationPort(session: AgentSession): ApplicationService {
	let service = services.get(session);
	if (!service) {
		service = new ApplicationService(session);
		services.set(session, service);
		registered.add(service);
		if (typeof session.subscribe === "function") service.start();
	}
	return service;
}
export function getApplicationPortForSession(sessionId: string): ApplicationService | undefined {
	const matches = [...registered].filter((service) => service.sessionId === sessionId);
	if (matches.length > 1) throw new Error("Multiple active application sessions share this session ID");
	return matches[0];
}

export interface ApplicationReceiptStore {
	begin(command: ApplicationCommand): {
		fresh: boolean;
		receipt: ApplicationReceipt;
	};
	finish(id: string, status: "completed" | "failed", message?: string): ApplicationReceipt;
}

export type ToolOutputProjector = (owner: string, result: unknown) => string | undefined;

export class ApplicationService implements LocalApplicationPort<AgentSessionEvent, AgentSession> {
	private outputProjector?: {
		project: ToolOutputProjector;
		active: boolean;
		previous?: ApplicationService["outputProjector"];
	};
	/** Project display text only; native results remain unchanged. Owners include custom message types. */
	setToolOutputProjector(project: ToolOutputProjector): () => void {
		const registration = { project, active: true, previous: this.outputProjector };
		this.outputProjector = registration;
		this.refreshOutputProjection();
		return () => {
			registration.active = false;
			if (this.outputProjector !== registration) return;
			let previous = registration.previous;
			while (previous && !previous.active) previous = previous.previous;
			this.outputProjector = previous;
			this.refreshOutputProjection();
		};
	}
	private projectedOutput(owner: string, value: unknown): string | undefined {
		try {
			return this.outputProjector?.project(owner, value);
		} catch {
			return "Tool output unavailable";
		}
	}
	private refreshOutputProjection(): void {
		// Previous previews cannot be safely reinterpreted without the original metadata.
		for (const [id, tool] of this.tools) this.tools.set(id, { ...tool, text: "Tool output unavailable" });
		for (const [id, message] of this.messages) {
			if (message.role !== "toolResult" && message.role !== "custom") continue;
			this.messages.set(id, { ...message, text: "Tool output unavailable" });
		}
		for (const source of this.session.messages ?? []) {
			const id = this.messageIds.get(source);
			const message = id && this.messages.get(id);
			if (!id || !message) continue;
			const owner =
				source.role === "toolResult" ? source.toolName : source.role === "custom" ? source.customType : undefined;
			if (owner) this.messages.set(id, { ...message, text: this.outputText(owner, source) });
		}
		this.epoch = randomUUID();
		this.sequence = 0;
		this.replay = [];
		this.replaySizes = [];
		this.replayChars = 0;
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(this.frame({ type: "resync", reason: "overflow" }));
	}

	private receiptStore?: ApplicationReceiptStore;
	setReceiptStore(store: ApplicationReceiptStore): void {
		this.receiptStore = store;
	}
	private epoch = randomUUID();
	private sequence = 0;
	private currentSession: string;
	private unsubscribe?: () => void;
	private native = new Set<AgentSessionEventListener>();
	private closes = new Set<() => void>();
	private sinks = new Set<(frame: ApplicationFrame) => void>();
	private replay: ApplicationFrame[] = [];
	/** Serialized length of each replay frame, so bounding the buffer does not reserialize it on every token. */
	private replaySizes: number[] = [];
	private replayChars = 0;
	private messages = new Map<string, ApplicationMessage>();
	private messageIds = new WeakMap<object, string>();
	private activeMessage?: string;
	private runId?: string;
	private tools = new Map<string, ApplicationTool>();
	/** Next `order` for a message or tool seen for the first time, so snapshots keep their interleaving. */
	private nextOrder = 0;
	private status: "idle" | "compacting" | "retrying" = "idle";
	private steering: string[] = [];
	private followUp: string[] = [];
	private receipts = new Map<string, { fingerprint: string; receipt: ApplicationReceipt }>();
	private disposed = false;

	private readonly session: AgentSession;
	constructor(session: AgentSession) {
		this.session = session;
		this.currentSession = session.sessionId;
	}
	get sessionId(): string {
		return this.session.sessionId;
	}
	start(): void {
		this.attach();
	}
	private attach(): void {
		if (this.disposed) throw new Error("Application service is closed");
		if (!this.unsubscribe) {
			if (this.session.isStreaming && !this.runId) this.runId = randomUUID();
			for (const message of this.session.messages ?? []) this.project({ type: "message_end", message });
		}
		this.unsubscribe ??= this.session.subscribe((event) => {
			this.checkSession();
			try {
				this.project(event);
			} catch (error) {
				console.error("Application projection failed", error);
				for (const sink of this.sinks) sink(this.frame({ type: "resync", reason: "overflow" }));
			} finally {
				// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so listeners added during dispatch do not receive this event
				for (const listener of [...this.native]) {
					try {
						Promise.resolve(listener(event)).catch((error) => console.error("Application listener failed", error));
					} catch (error) {
						console.error("Application listener failed", error);
					}
				}
			}
		});
	}
	private checkSession(): void {
		if (this.currentSession === this.session.sessionId) return;
		this.currentSession = this.session.sessionId;
		this.epoch = randomUUID();
		this.sequence = 0;
		this.replay = [];
		this.replaySizes = [];
		this.replayChars = 0;
		this.messages.clear();
		this.tools.clear();
		this.status = "idle";
		this.receipts.clear();
		this.runId = undefined;
		this.activeMessage = undefined;
		this.steering = [];
		this.followUp = [];
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(this.frame({ type: "resync", reason: "session-changed" }));
	}
	private cursor(): ApplicationCursor {
		return {
			sessionId: this.currentSession,
			epoch: this.epoch,
			sequence: this.sequence,
		};
	}
	private frame(
		payload:
			| Omit<Extract<ApplicationFrame, { type: "snapshot" }>, "protocolVersion" | "cursor" | "at">
			| Omit<Extract<ApplicationFrame, { type: "event" }>, "protocolVersion" | "cursor" | "at">
			| { type: "resumed" }
			| { type: "resync"; reason: "overflow" | "session-changed" },
	): ApplicationFrame {
		return {
			protocolVersion: 1,
			cursor: this.cursor(),
			at: Date.now(),
			...payload,
		};
	}
	publishDomain(event: ApplicationEvent): void {
		this.checkSession();
		if (event.type === "session.status") this.status = event.status;
		if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed") {
			const previous = this.tools.get(event.toolCallId);
			const hint = event.hint ?? previous?.hint;
			const tool: ApplicationTool = {
				toolCallId: event.toolCallId,
				order: previous?.order ?? this.nextOrder++,
				toolName: event.toolName,
				...(hint ? { hint } : {}),
				text: event.text ?? previous?.text ?? "",
				status: event.type === "tool.completed" ? (event.failed ? "failed" : "completed") : "running",
			};
			this.tools.set(event.toolCallId, tool);
			event = { ...event, order: tool.order };
			while (this.tools.size > 1 && (this.tools.size > 50 || JSON.stringify([...this.tools.values()]).length > 65536))
				this.tools.delete(this.tools.keys().next().value!);
		}
		this.sequence++;
		const frame = this.frame({ type: "event", event });
		const size = JSON.stringify(frame).length;
		this.replay.push(frame);
		this.replaySizes.push(size);
		this.replayChars += size;
		// The length `JSON.stringify(this.replay)` would have: the frames, their commas and the brackets.
		while (this.replay.length > 200 || 2 + this.replayChars + Math.max(this.replay.length - 1, 0) > 262144) {
			this.replay.shift();
			this.replayChars -= this.replaySizes.shift()!;
		}
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(frame);
	}
	private queuePreview(values: string[]): string[] {
		return values
			.slice(-10)
			.map((text) => (text.length > 1000 ? `${text.slice(0, 1000)} [Queue preview shortened]` : text));
	}
	private snapshot(): ApplicationSnapshot {
		return {
			sessionId: this.currentSession,
			tools: [...this.tools.values()].map((tool) => ({ ...tool })),
			status: this.status,
			runId: this.runId,
			messages: [...this.messages.values()].map((message) => ({ ...message })),
			streaming: this.session.isStreaming,
			steering: this.queuePreview(this.steering),
			followUp: this.queuePreview(this.followUp),
			receipts: [...this.receipts.values()].slice(-20).map((value) => ({
				...value.receipt,
				...(value.receipt.message ? { message: value.receipt.message.slice(0, 1000) } : {}),
			})),
			capabilities: ["prompt", "steer", "followUp", "abort"],
		};
	}
	connect(options: { sessionId?: string; cursor?: ApplicationCursor } = {}): ApplicationConnection {
		this.attach();
		this.checkSession();
		if (options.sessionId && options.sessionId !== this.currentSession) throw new Error("Session changed");
		const boundSession = this.currentSession;
		let closed = false;
		let overflowed = false;
		let queue: ApplicationFrame[] = [];
		let bytes = 0;
		let waiting: ((result: IteratorResult<ApplicationFrame>) => void) | undefined;
		const push = (frame: ApplicationFrame) => {
			if (closed) return;
			if (frame.type === "resync") {
				queue = [];
				bytes = 0;
				overflowed = false;
			}
			if (overflowed) return;
			if (waiting) {
				const resolve = waiting;
				waiting = undefined;
				resolve({ value: frame, done: false });
				return;
			}
			const size = JSON.stringify(frame).length;
			if (queue.length >= 200 || bytes + size > 262144) {
				overflowed = true;
				queue = [this.frame({ type: "resync", reason: "overflow" })];
				bytes = JSON.stringify(queue[0]).length;
				return;
			}
			queue.push(frame);
			bytes += size;
		};
		const cursor = options.cursor;
		if (
			cursor &&
			cursor.sessionId === this.currentSession &&
			cursor.epoch === this.epoch &&
			cursor.sequence <= this.sequence &&
			cursor.sequence >= (this.replay[0]?.cursor.sequence ?? this.sequence + 1) - 1
		) {
			push({ ...this.frame({ type: "resumed" }), cursor: { ...cursor } });
			for (const frame of this.replay) if (frame.cursor.sequence > cursor.sequence) push(frame);
		} else push(this.frame({ type: "snapshot", snapshot: this.snapshot() }));
		this.sinks.add(push);
		const close = () => {
			this.closes.delete(close);
			closed = true;
			this.sinks.delete(push);
			queue = [];
			waiting?.({ value: undefined, done: true });
			waiting = undefined;
		};
		this.closes.add(close);
		const iterator: AsyncIterator<ApplicationFrame> = {
			next: () => {
				const frame = queue.shift();
				if (frame) {
					bytes -= JSON.stringify(frame).length;
					return Promise.resolve({ value: frame, done: false });
				}
				if (closed) return Promise.resolve({ value: undefined, done: true });
				if (waiting) return Promise.reject(new Error("Concurrent stream reads are unsupported"));
				return new Promise((resolve) => {
					waiting = resolve;
				});
			},
			return: async () => {
				close();
				return { value: undefined, done: true };
			},
		};
		return {
			[Symbol.asyncIterator]: () => iterator,
			close,
			execute: (command) => {
				if (closed || this.sessionId !== boundSession)
					return Promise.reject(new Error("Connection closed or session changed"));
				return this.execute(command);
			},
		};
	}
	subscribeNative(listener: AgentSessionEventListener): () => void {
		this.attach();
		this.native.add(listener);
		return () => this.native.delete(listener);
	}
	invoke<K extends Method>(operation: K, ...args: Args<K>): Result<K> {
		if (this.disposed) throw new Error("Application service is closed");
		const method = this.session[operation] as (...parameters: Args<K>) => Result<K>;
		return method.apply(this.session, args);
	}
	async execute(command: ApplicationCommand): Promise<ApplicationReceipt> {
		this.attach();
		this.checkSession();
		if (!Value.Check(ApplicationCommandSchema, command)) throw new Error("Invalid application command");
		if (command.sessionId !== this.currentSession) throw new Error("Session changed");
		const fingerprint = applicationCommandFingerprint(command);
		const previous = this.receipts.get(command.id);
		if (previous) {
			if (previous.fingerprint !== fingerprint) throw new Error("Request ID already used with another command");
			return { ...previous.receipt };
		}
		if (command.action === "abort" && command.runId !== this.runId) throw new Error("Run changed");
		if (this.receipts.size >= 1000) throw new Error("Command receipt capacity reached; start a new session");
		const receiptStore = this.receiptStore;
		const recorded = receiptStore?.begin(command);
		if (recorded && !recorded.fresh) return recorded.receipt;
		const receipt: ApplicationReceipt = recorded?.receipt ?? {
			id: command.id,
			status: "accepted",
		};
		this.receipts.set(command.id, { fingerprint, receipt });
		this.publishDomain({ type: "command.receipt", receipt: { ...receipt } });
		const sessionAtDispatch = this.currentSession;
		const work = Promise.resolve().then<unknown>(() => {
			if (this.disposed || this.sessionId !== sessionAtDispatch) throw new Error("Session changed before dispatch");
			if (command.action === "abort" && command.runId !== this.runId) throw new Error("Run changed before dispatch");
			return command.action === "abort" ? this.invoke("abort") : this.invoke(command.action, command.text);
		});
		Promise.resolve(work)
			.then(
				() => {
					if (this.disposed || this.sessionId !== sessionAtDispatch) return;
					receipt.status = "completed";
					receiptStore?.finish(command.id, "completed");
					this.publishDomain({
						type: "command.receipt",
						receipt: { ...receipt },
					});
				},
				(error) => {
					if (this.disposed || this.sessionId !== sessionAtDispatch) return;
					receipt.status = "failed";
					receipt.message = error instanceof Error ? redactSecrets(error.message).slice(0, 1000) : "Command failed";
					receiptStore?.finish(command.id, "failed", receipt.message);
					this.publishDomain({
						type: "command.receipt",
						receipt: { ...receipt },
					});
				},
			)
			.catch((error) => {
				console.error("Application receipt persistence failed", error);
				if (!this.disposed && this.sessionId === sessionAtDispatch) {
					receipt.status = "failed";
					receipt.message = "Command outcome could not be persisted; inspect the session before retrying.";
					this.publishDomain({
						type: "command.receipt",
						receipt: { ...receipt },
					});
				}
			});
		return { ...receipt };
	}
	private project(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.runId = randomUUID();
				this.publishDomain({ type: "run.started", runId: this.runId });
				break;
			case "agent_settled":
				this.publishDomain({
					type: "run.settled",
					runId: this.runId ?? "unknown",
					aborted: event.aborted,
				});
				this.runId = undefined;
				break;
			case "message_start":
			case "message_end": {
				const id =
					this.messageIds.get(event.message) ??
					(event.message.role === "assistant" ? this.activeMessage : undefined) ??
					randomUUID();
				this.messageIds.set(event.message, id);
				const content = "content" in event.message ? event.message.content : undefined;
				const owner =
					event.message.role === "toolResult"
						? event.message.toolName
						: event.message.role === "custom"
							? event.message.customType
							: undefined;
				const projected = owner ? this.projectedOutput(owner, event.message) : undefined;
				const text =
					projected ??
					(typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.map((block) =>
										block.type === "text"
											? block.text
											: block.type === "image"
												? "[Image attachment: open the session to view]"
												: block.type === "toolCall"
													? `[Tool call: ${block.name}]`
													: "[Content available in the session]",
									)
									.join("")
							: "");
				const message = {
					id,
					role: event.message.role,
					text: text.slice(-64000),
					complete: event.type === "message_end",
					order: this.messages.get(id)?.order ?? this.nextOrder++,
				};
				this.messages.set(id, message);
				if (message.role === "assistant") this.activeMessage = message.complete ? undefined : id;
				while (
					this.messages.size > 1 &&
					(this.messages.size > 50 || JSON.stringify([...this.messages.values()]).length > 131072)
				)
					this.messages.delete(this.messages.keys().next().value!);
				this.publishDomain({
					type: message.complete ? "message.completed" : "message.started",
					message,
				});
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type !== "text_delta") break;
				let id = this.messageIds.get(event.message) ?? this.activeMessage;
				if (!id) {
					id = randomUUID();
					this.activeMessage = id;
				}
				this.messageIds.set(event.message, id);
				let message = this.messages.get(id);
				if (!message) {
					message = {
						id,
						role: "assistant",
						text: "",
						complete: false,
						order: this.nextOrder++,
					};
					this.messages.set(id, message);
					this.publishDomain({ type: "message.started", message });
				}
				this.messages.set(id, {
					...message,
					text: (message.text + update.delta).slice(-64000),
				});
				this.publishDomain({
					type: "message.delta",
					messageId: id,
					delta: update.delta.slice(-64000),
					text: this.messages.get(id)!.text,
				});
				break;
			}
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end": {
				// A redacted one-line label from the arguments; later frames replace `text` with output, the hint stays.
				const hint = event.type === "tool_execution_start" ? toolHint(event.args) : "";
				this.publishDomain({
					type:
						event.type === "tool_execution_start"
							? "tool.started"
							: event.type === "tool_execution_update"
								? "tool.progress"
								: "tool.completed",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					...(hint ? { hint } : {}),
					...(event.type === "tool_execution_end"
						? { failed: event.isError, text: this.outputText(event.toolName, event.result) }
						: event.type === "tool_execution_update"
							? { text: this.outputText(event.toolName, event.partialResult) }
							: {}),
				});
				break;
			}
			case "queue_update":
				this.steering = [...event.steering];
				this.followUp = [...event.followUp];
				this.publishDomain({
					type: "queue.changed",
					steering: this.queuePreview(this.steering),
					followUp: this.queuePreview(this.followUp),
				});
				break;
			case "compaction_start":
				this.publishDomain({ type: "session.status", status: "compacting" });
				break;
			case "auto_retry_start":
				this.publishDomain({ type: "session.status", status: "retrying" });
				break;
			case "compaction_end":
			case "auto_retry_end":
				this.publishDomain({ type: "session.status", status: "idle" });
				break;
		}
	}
	private outputText(owner: string, value: unknown): string {
		const projected = this.projectedOutput(owner, value);
		if (projected !== undefined) return keepEnds(projected, OUTPUT_CHARS);
		if (value && typeof value === "object" && "content" in value && typeof value.content === "string")
			return keepEnds(value.content, OUTPUT_CHARS);
		if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return "";
		const text = value.content
			.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		return keepEnds(text, OUTPUT_CHARS);
	}
	dispose(): void {
		for (const close of this.closes) close();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.native.clear();
		for (const sink of this.sinks) sink(this.frame({ type: "resync", reason: "session-changed" }));
		this.sinks.clear();
		this.disposed = true;
		registered.delete(this);
		services.delete(this.session);
	}
}
