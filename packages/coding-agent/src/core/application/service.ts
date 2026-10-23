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
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../agent-session.ts";
import { dispatchCommand } from "./service/commands.ts";
import { type MessageProjectionHost, projectMessage, projectMessageUpdate, toolDomainEvent } from "./service/events.ts";
import { appendReplayFrame, createFrameQueue } from "./service/frames.ts";
import { keepEnds, OUTPUT_CHARS, queuePreview, toolResultText, trimOldest } from "./service/projection.ts";
import type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

export type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

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
	private readonly messageHost: MessageProjectionHost = {
		messages: this.messages,
		messageIds: this.messageIds,
		getActiveMessage: () => this.activeMessage,
		setActiveMessage: (id) => {
			this.activeMessage = id;
		},
		nextOrder: () => this.nextOrder++,
		projectedOutput: (owner, value) => this.projectedOutput(owner, value),
		publishDomain: (event) => this.publishDomain(event),
	};

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
			trimOldest(this.tools, 50, 65536);
		}
		this.sequence++;
		const frame = this.frame({ type: "event", event });
		this.replayChars = appendReplayFrame(this.replay, this.replaySizes, this.replayChars, frame);
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(frame);
	}
	private snapshot(): ApplicationSnapshot {
		return {
			sessionId: this.currentSession,
			tools: [...this.tools.values()].map((tool) => ({ ...tool })),
			status: this.status,
			runId: this.runId,
			messages: [...this.messages.values()].map((message) => ({ ...message })),
			streaming: this.session.isStreaming,
			steering: queuePreview(this.steering),
			followUp: queuePreview(this.followUp),
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
		const connection = createFrameQueue(
			() => this.frame({ type: "resync", reason: "overflow" }),
			() => {
				this.closes.delete(connection.close);
				this.sinks.delete(connection.push);
			},
		);
		const { push, close } = connection;
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
		this.closes.add(close);
		return {
			[Symbol.asyncIterator]: () => connection.iterator,
			close,
			execute: (command) => {
				if (connection.isClosed() || this.sessionId !== boundSession)
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
		dispatchCommand({
			command,
			receipt,
			receiptStore,
			isCurrent: () => !this.disposed && this.sessionId === sessionAtDispatch,
			runId: () => this.runId,
			invoke: () => (command.action === "abort" ? this.invoke("abort") : this.invoke(command.action, command.text)),
			publishDomain: (event) => this.publishDomain(event),
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
			case "message_end":
				projectMessage(this.messageHost, event);
				break;
			case "message_update":
				projectMessageUpdate(this.messageHost, event);
				break;
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				this.publishDomain(toolDomainEvent(event, (owner, value) => this.outputText(owner, value)));
				break;
			case "queue_update":
				this.steering = [...event.steering];
				this.followUp = [...event.followUp];
				this.publishDomain({
					type: "queue.changed",
					steering: queuePreview(this.steering),
					followUp: queuePreview(this.followUp),
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
		return toolResultText(value);
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
