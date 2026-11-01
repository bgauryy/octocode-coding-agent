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
	type ApplicationAsset,
	type ApplicationAssetInput,
	type ApplicationAssetPayload,
	type ApplicationHistory,
	type ApplicationReceipt,
	type ApplicationSnapshot,
	type LocalApplicationPort,
	type ApplicationOperation,
	type ApplicationOperationArgs,
	type ApplicationOperationResult,
} from "@octocodeai/octocode-contracts";
import type { AgentSessionEvent, AgentSessionEventListener } from "../agent-session/types.ts";
import { type ApplicationOperations, type ApplicationSession, invokeOperation } from "./session-port.ts";
import { commandImages, dispatchCommand, invokeCommand } from "./service/commands.ts";
import { ApplicationTranscript } from "./transcript.ts";
import { applicationSnapshot } from "./snapshot.ts";
import { lifecycleEvent } from "./service/lifecycle.ts";
import { applicationModel, publishModelChange } from "./service/model.ts";
import { acceptApplicationEvent, createApplicationState, initialApplicationState, reserveReceipt } from "./state.ts";
import { ApplicationActivities } from "./service/activities.ts";
import { ApplicationDelivery, type ListenerErrorHandler } from "./service/delivery.ts";
import { ContextSource } from "./service/context-source.ts";
import { cloneDisplay } from "./normalize.ts";
import {
	createApplicationFrame,
	createFrameQueue,
	ReplayBuffer,
	type ApplicationFramePayload,
} from "./service/frames.ts";
import { ApplicationWire, type StreamHint } from "./service/wire.ts";
import type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

export type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

type Method = ApplicationOperation<ApplicationOperations>;
type Args<K extends Method> = ApplicationOperationArgs<ApplicationOperations, K>;
type Result<K extends Method> = ApplicationOperationResult<ApplicationOperations, K>;
export class ApplicationService implements LocalApplicationPort<AgentSessionEvent, ApplicationOperations> {
	private readonly state = createApplicationState();
	private readonly transcript = new ApplicationTranscript(this.state);
	private readonly activities = new ApplicationActivities(this.transcript.assets, this.state);
	private readonly delivery = new ApplicationDelivery(this.state, () => this.snapshot());
	private readonly source = new ContextSource();
	setToolOutputProjector(project: ToolOutputProjector): () => void {
		this.assertOpen();
		let active = true;
		let remove: (() => void) | undefined;
		this.delivery.run(() => {
			if (active && !this.disposed) remove = this.transcript.setProjector(project, () => this.invalidateReplay());
		});
		return () => {
			active = false;
			this.delivery.run(() => {
				if (!this.disposed) remove?.();
			});
		};
	}
	private invalidateReplay(): void {
		this.epoch = randomUUID();
		this.sequence = 0;
		this.replay.clear();
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(this.frame({ type: "resync", reason: "overflow" }));
		this.delivery.notify();
	}

	private receiptStore?: ApplicationReceiptStore;
	setReceiptStore(store: ApplicationReceiptStore): void {
		this.receiptStore = store;
	}
	private epoch = randomUUID();
	private sequence = 0;
	private get currentSession(): string {
		return this.state.getState().sessionId;
	}
	private unsubscribe?: () => void;
	private closes = new Set<() => void>();
	private sinks = new Set<(frame: ApplicationFrame) => void>();
	private readonly replay = new ReplayBuffer();
	private readonly wire = new ApplicationWire();
	private disposed = false;

	private readonly session: ApplicationSession;
	private readonly onDispose?: (service: ApplicationService) => void;
	constructor(session: ApplicationSession, onDispose?: (service: ApplicationService) => void) {
		this.onDispose = onDispose;
		this.session = session;
		this.state.setState({ sessionId: session.sessionId, model: applicationModel(session) });
		this.source.reset(session);
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
			this.delivery.run(() => {
				this.seedActivities();
				if (this.session.isStreaming && !this.state.getState().runId)
					this.state.setState({ runId: randomUUID(), streaming: true });
				this.hydrate(true);
			});
		}
		this.unsubscribe ??= this.session.subscribe((event) =>
			this.delivery.runForSession(this.session, () => {
				if (this.disposed) return;
				this.checkSession();
				this.safely(() => this.project(event));
				this.delivery.notifyNative(event);
			}),
		);
	}
	private hydrate(initial = false): void {
		this.transcript.batch(() => {
			for (const message of this.session.messages ?? []) {
				if (this.disposed) break;
				this.safely(() =>
					initial
						? this.project({ type: "message_end", message })
						: this.transcript.message({ type: "message_end", message }, () => {}),
				);
			}
		});
	}
	private seedActivities(): void {
		this.activities.batch(() => {
			for (const entry of this.session.sessionManager?.getBranch() ?? [])
				this.safely(() => {
					this.activities.entry(entry);
				});
		});
	}
	private safely(work: () => void): void {
		try {
			work();
		} catch (error) {
			this.publish({
				type: "application.error",
				id: randomUUID(),
				code: "content-unavailable",
				message: `Some content could not be displayed; the original remains in the session. ${error instanceof Error ? error.message.slice(0, 500) : "Projection failed"}`,
			});
		}
	}
	private checkSession(): void {
		const changedSession = this.currentSession !== this.session.sessionId;
		if (!changedSession && this.source.unchanged(this.session, this.transcript)) return;
		this.state.setState({ sessionId: this.session.sessionId, model: applicationModel(this.session) });
		this.source.reset(this.session);
		this.epoch = randomUUID();
		this.sequence = 0;
		this.replay.clear();
		this.wire.clear();
		this.transcript.clear();
		this.activities.clear();
		this.state.setState(
			changedSession
				? { ...initialApplicationState(this.session.sessionId), revision: this.state.getState().revision }
				: { errors: [] },
		);
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(this.frame({ type: "resync", reason: "session-changed" }));
		this.hydrate();
		this.seedActivities();
		this.publish({
			type: "session.reset",
			...this.transcript.window(),
			...this.activities.window(),
			errors: cloneDisplay(this.state.getState().errors),
		});
	}
	private cursor(): ApplicationCursor {
		return {
			sessionId: this.currentSession,
			epoch: this.epoch,
			sequence: this.sequence,
		};
	}
	private frame(payload: ApplicationFramePayload): ApplicationFrame {
		return createApplicationFrame(this.cursor(), payload);
	}
	publishDomain(event: ApplicationEvent): void {
		if (this.disposed) throw new Error("Application service is closed");
		const sessionId = this.sessionId;
		this.delivery.run(() => {
			if (sessionId === this.sessionId) this.publish(event);
		});
	}
	/** False once publishing closed the service. */
	private publish(event: ApplicationEvent, hint?: StreamHint): boolean {
		if (this.disposed) return false;
		this.checkSession();
		acceptApplicationEvent(this.state, event);
		if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed") {
			event = this.transcript.acceptTool(event);
		}
		this.emit(event, hint);
		this.delivery.notify(event);
		return !this.disposed;
	}
	// A streamed delta that releases nothing yet becomes no frame and uses no sequence.
	private emit(event: ApplicationEvent, hint?: StreamHint): void {
		const wired = this.wire.event(event, hint);
		if (!wired) return;
		this.sequence++;
		const frame = this.frame({ type: "event", event: wired });
		this.replay.push(frame);
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(frame);
	}
	private snapshot(): ApplicationSnapshot {
		return applicationSnapshot(this.state.getState(), this.transcript, this.activities);
	}

	getSnapshot(): ApplicationSnapshot {
		this.assertOpen();
		this.attach();
		return this.snapshot();
	}
	subscribeState(listener: (snapshot: ApplicationSnapshot) => void, onError?: ListenerErrorHandler): () => void {
		this.assertOpen();
		this.attach();
		return this.delivery.subscribeState(listener, onError);
	}
	connect(options: { sessionId?: string; cursor?: ApplicationCursor } = {}): ApplicationConnection {
		this.attach();
		this.delivery.run(() => this.checkSession());
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
			cursor.sequence >= (this.replay.frames[0]?.cursor.sequence ?? this.sequence + 1) - 1
		) {
			push({ ...this.frame({ type: "resumed" }), cursor: { ...cursor } });
			for (const frame of this.replay.frames) if (frame.cursor.sequence > cursor.sequence) push(frame);
		} else push(this.frame({ type: "snapshot", snapshot: this.wire.snapshot(this.snapshot()) }));
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
	/** The same semantic events consumed by remote interfaces, delivered synchronously for terminal rendering. */
	subscribe(listener: (event: ApplicationEvent) => void, onError?: ListenerErrorHandler): () => void {
		this.attach();
		return this.delivery.subscribe(listener, onError);
	}
	normalizeMessage(message: unknown, id?: string): ApplicationMessage {
		this.assertOpen();
		let normalized: ApplicationMessage | undefined;
		this.safely(() => {
			normalized = this.transcript.normalize(message, id);
		});
		return normalized ?? this.transcript.unavailable(message, id);
	}
	readAsset(id: string, sessionId?: string): ApplicationAssetPayload | undefined {
		this.assertOpen(sessionId);
		return this.transcript.assets.get(id);
	}
	uploadAsset(input: ApplicationAssetInput, sessionId?: string): ApplicationAsset {
		this.assertOpen(sessionId);
		return this.transcript.assets.upload(input);
	}
	history(
		options: { before?: string; activityBefore?: string; limit?: number; sessionId?: string } = {},
	): ApplicationHistory {
		this.assertOpen(options.sessionId);
		this.attach();
		return { ...this.transcript.history(options), ...this.activities.history(options) };
	}
	private assertOpen(sessionId?: string): void {
		if (this.disposed) throw new Error("Application service is closed");
		if (sessionId !== undefined && sessionId !== this.session.sessionId) throw new Error("Session changed");
		this.delivery.run(() => {
			if (!this.disposed) this.checkSession();
		});
	}
	subscribeNative(listener: AgentSessionEventListener, onError?: ListenerErrorHandler): () => void {
		this.attach();
		return this.delivery.subscribeNative(listener, onError);
	}
	invoke<K extends Method>(operation: K, ...args: Args<K>): Result<K> {
		if (this.disposed) throw new Error("Application service is closed");
		return invokeOperation(this.session, operation, args);
	}
	async execute(command: ApplicationCommand): Promise<ApplicationReceipt> {
		this.attach();
		return this.delivery.request(() => this.acceptCommand(command));
	}
	private acceptCommand(command: ApplicationCommand): ApplicationReceipt {
		this.attach();
		this.checkSession();
		if (!Value.Check(ApplicationCommandSchema, command)) throw new Error("Invalid application command");
		if (command.sessionId !== this.currentSession) throw new Error("Session changed");
		const fingerprint = applicationCommandFingerprint(command);
		const previous = this.state.getState().receipts.get(command.id);
		if (previous) {
			if (previous.fingerprint !== fingerprint) throw new Error("Request ID already used with another command");
			return { ...previous.receipt };
		}
		if (command.action === "abort" && command.runId !== this.state.getState().runId) throw new Error("Run changed");
		const images = commandImages(command, this.transcript.assets, this.session);
		reserveReceipt(this.state);
		const receiptStore = this.receiptStore;
		const recorded = receiptStore?.begin(command);
		if (recorded && !recorded.fresh) return recorded.receipt;
		const receipt: ApplicationReceipt = recorded?.receipt ?? { id: command.id, status: "accepted" };
		this.state.setState(({ receipts }) => ({
			receipts: new Map(receipts).set(command.id, { fingerprint, receipt: { ...receipt } }),
		}));
		this.publish({ type: "command.receipt", receipt: { ...receipt } });
		const sessionAtDispatch = this.currentSession;
		dispatchCommand({
			command,
			receipt,
			receiptStore,
			isCurrent: () => !this.disposed && this.sessionId === sessionAtDispatch,
			runId: () => this.state.getState().runId,
			invoke: () => {
				if (this.disposed) throw new Error("Application service is closed");
				return invokeCommand(command, images, this.session);
			},
			publishDomain: (event) => this.publishDomain(event),
			reportFailure: (error) => this.delivery.reportFailure(error),
		});
		return { ...receipt };
	}
	private project(event: AgentSessionEvent): void {
		publishModelChange(this.session, this.state, (change) => this.publish(change));
		switch (event.type) {
			case "message_start":
			case "message_end":
			case "message_update":
				this.transcript.message(event, this.publish.bind(this), this.emit.bind(this));
				break;
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				this.publish(this.transcript.tool(event));
				break;
			default:
				const lifecycle = lifecycleEvent(event, this.state.getState().runId);
				if (lifecycle) this.publish(lifecycle);
		}
		if (this.disposed) return;
		const activity = this.activities.project(event);
		if (activity) this.publish({ type: "session.activity", activity });
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.delivery.close();
		for (const close of this.closes) close();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.transcript.clear();
		this.activities.clear();
		this.state.setState(initialApplicationState(this.sessionId));
		this.sinks.clear();
		this.replay.clear();
		this.wire.clear();
		this.source.clear();
		this.receiptStore = undefined;
		this.onDispose?.(this);
	}
}
