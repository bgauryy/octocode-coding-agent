import { randomUUID } from "node:crypto";
import {
	type ApplicationCommand,
	type ApplicationConnection,
	type ApplicationCursor,
	type ApplicationEvent,
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
import type { AgentSessionEvent } from "../agent-session/types.ts";
import { type ApplicationOperations, type ApplicationSession, invokeOperation } from "./session-port.ts";
import { acceptApplicationCommand, type RecordingCommand } from "./service/accept.ts";
import { ApplicationTranscript } from "./transcript.ts";
import { applicationSnapshot } from "./snapshot.ts";
import { publishLifecycle } from "./service/lifecycle.ts";
import { applicationModel, publishModelChange } from "./service/model.ts";
import { acceptApplicationEvent, createApplicationState, initialApplicationState } from "./state.ts";
import { readOnlyApplicationState } from "./service/state-source.ts";
import { ApplicationActivities } from "./service/activities.ts";
import { ApplicationDelivery, type ListenerErrorHandler, type NativeListener } from "./service/delivery.ts";
import { ContextSource } from "./service/context-source.ts";
import { cloneDisplay } from "./normalize.ts";
import { ReplayBuffer } from "./service/frames.ts";
import { ApplicationFrameStream } from "./service/stream.ts";
import type { StreamHint } from "./service/wire.ts";
import type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

export type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

type Method = ApplicationOperation<ApplicationOperations>;
type Args<K extends Method> = ApplicationOperationArgs<ApplicationOperations, K>;
type Result<K extends Method> = ApplicationOperationResult<ApplicationOperations, K>;
export class ApplicationService implements LocalApplicationPort<AgentSessionEvent, ApplicationOperations> {
	private readonly state = createApplicationState();
	readonly stateSource = readOnlyApplicationState(this.state);
	private readonly transcript = new ApplicationTranscript(this.state, () => this.session);
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
		this.stream.restart(false);
		this.stream.resync("overflow");
		this.delivery.notify();
	}

	private receiptStore?: ApplicationReceiptStore;
	private readonly recording = new Map<string, RecordingCommand>();
	setReceiptStore(store: ApplicationReceiptStore): void {
		this.receiptStore = store;
	}
	private get currentSession(): string {
		return this.state.getState().sessionId;
	}
	private unsubscribe?: () => void;
	private readonly replay = new ReplayBuffer();
	private readonly stream = new ApplicationFrameStream(() => this.currentSession, this.replay);
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
		const unseen = changedSession ? undefined : this.source.adopt(this.session, this.transcript);
		if (unseen) {
			// The context grew by messages nothing announced (a boundary draft): show them without rebuilding the rest.
			for (const message of unseen)
				this.safely(() => this.transcript.message({ type: "message_end", message }, this.publish.bind(this)));
			return;
		}
		this.state.setState({ sessionId: this.session.sessionId, model: applicationModel(this.session) });
		this.source.reset(this.session);
		this.stream.restart(true);
		this.transcript.clear();
		this.activities.clear();
		this.state.setState(
			changedSession
				? { ...initialApplicationState(this.session.sessionId), revision: this.state.getState().revision }
				: { errors: [] },
		);
		this.stream.resync("session-changed");
		this.hydrate();
		this.seedActivities();
		this.publish({
			type: "session.reset",
			...this.transcript.window(),
			...this.activities.window(),
			errors: cloneDisplay(this.state.getState().errors),
		});
	}
	publishDomain(event: ApplicationEvent): void {
		if (this.disposed) throw new Error("Application service is closed");
		const sessionId = this.sessionId;
		this.delivery.run(() => {
			if (sessionId === this.sessionId) this.publish(event);
		});
	}
	/** False once publishing closed the service. */
	private publish(received: ApplicationEvent, hint?: StreamHint): boolean {
		if (this.disposed) return false;
		this.checkSession();
		acceptApplicationEvent(this.state, received);
		const event =
			received.type === "tool.started" || received.type === "tool.progress" || received.type === "tool.completed"
				? this.transcript.acceptTool(received)
				: received;
		this.stream.emit(event, hint);
		this.delivery.notify(event);
		return !this.disposed;
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
		const connection = this.stream.connect(options.cursor, () => this.snapshot());
		const { close } = connection;
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
	subscribeNative(listener: NativeListener, onError?: ListenerErrorHandler): () => void {
		this.attach();
		return this.delivery.subscribeNative(listener, onError);
	}
	invoke<K extends Method>(operation: K, ...args: Args<K>): Result<K> {
		if (this.disposed) throw new Error("Application service is closed");
		return invokeOperation(this.session, operation, args);
	}
	async execute(command: ApplicationCommand): Promise<ApplicationReceipt> {
		this.attach();
		return acceptApplicationCommand(command, {
			state: this.state,
			assets: this.transcript.assets,
			session: this.session,
			receiptStore: this.receiptStore,
			recording: this.recording,
			deliver: (work) =>
				this.delivery.request(() => {
					this.attach();
					this.checkSession();
					return work();
				}),
			currentSession: () => this.currentSession,
			isOpen: () => !this.disposed,
			sessionId: () => this.sessionId,
			publish: (event) => this.publish(event),
			publishDomain: (event) => this.publishDomain(event),
			reportFailure: (error) => this.delivery.reportFailure(error),
		});
	}
	private project(event: AgentSessionEvent): void {
		publishModelChange(this.session, this.state, (change) => this.publish(change));
		switch (event.type) {
			case "message_start":
			case "message_end":
			case "message_update":
				this.transcript.message(event, this.publish.bind(this), this.stream.emit.bind(this.stream));
				break;
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				this.publish(this.transcript.tool(event));
				break;
			default:
				publishLifecycle(event, this.state.getState().runId, (lifecycle) => this.publish(lifecycle));
		}
		if (this.disposed) return;
		const activity = this.activities.project(event);
		if (activity) this.publish({ type: "session.activity", activity });
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.delivery.close();
		this.stream.closeConnections();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.transcript.clear();
		this.activities.clear();
		this.state.setState(initialApplicationState(this.sessionId));
		this.stream.clear();
		this.source.clear();
		this.receiptStore = undefined;
		this.onDispose?.(this);
	}
}
