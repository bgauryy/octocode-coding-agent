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
} from "@octocodeai/octocode-contacts";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../agent-session.ts";
import { commandImages, dispatchCommand } from "./service/commands.ts";
import { ApplicationTranscript } from "./transcript.ts";
import { applicationSnapshot } from "./snapshot.ts";
import { lifecycleEvent } from "./service/lifecycle.ts";
import { acceptApplicationEvent, createApplicationState, initialApplicationState } from "./state.ts";
import { ApplicationActivities } from "./service/activities.ts";
import { ApplicationDelivery } from "./service/delivery.ts";
import { cloneDisplay } from "./normalize.ts";
import {
	appendReplayFrame,
	createApplicationFrame,
	createFrameQueue,
	type ApplicationFramePayload,
} from "./service/frames.ts";
import type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

export type { ApplicationReceiptStore, ToolOutputProjector } from "./service/types.ts";

type Method = ApplicationOperation<AgentSession>;
type Args<K extends Method> = ApplicationOperationArgs<AgentSession, K>;
type Result<K extends Method> = ApplicationOperationResult<AgentSession, K>;
export class ApplicationService implements LocalApplicationPort<AgentSessionEvent, AgentSession> {
	private readonly state = createApplicationState();
	private readonly transcript = new ApplicationTranscript(this.state);
	private readonly activities = new ApplicationActivities(this.transcript.assets, this.state);
	private readonly delivery = new ApplicationDelivery(this.state, () => this.snapshot());
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
	private clearReplay(): void {
		this.replay = [];
		this.replaySizes = [];
		this.replayChars = 0;
	}
	private invalidateReplay(): void {
		this.epoch = randomUUID();
		this.sequence = 0;
		this.clearReplay();
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
	private sourceMessages: readonly unknown[];
	private unsubscribe?: () => void;
	private closes = new Set<() => void>();
	private sinks = new Set<(frame: ApplicationFrame) => void>();
	private replay: ApplicationFrame[] = [];
	private replaySizes: number[] = [];
	private replayChars = 0;
	private disposed = false;

	private readonly session: AgentSession;
	private readonly onDispose?: (service: ApplicationService) => void;
	constructor(session: AgentSession, onDispose?: (service: ApplicationService) => void) {
		this.onDispose = onDispose;
		this.session = session;
		this.state.setState({ sessionId: session.sessionId });
		this.sourceMessages = session.messages;
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
		if (!changedSession && this.sourceMessages === this.session.messages) return;
		this.state.setState({ sessionId: this.session.sessionId });
		this.sourceMessages = this.session.messages;
		this.epoch = randomUUID();
		this.sequence = 0;
		this.clearReplay();
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
	private publish(event: ApplicationEvent): void {
		if (this.disposed) return;
		this.checkSession();
		acceptApplicationEvent(this.state, event);
		if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed") {
			event = this.transcript.acceptTool(event);
		}
		this.sequence++;
		const frame = this.frame({ type: "event", event });
		this.replayChars = appendReplayFrame(this.replay, this.replaySizes, this.replayChars, frame);
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(frame);
		this.delivery.notify(event);
	}
	private snapshot(): ApplicationSnapshot {
		return applicationSnapshot(this.state.getState(), this.transcript, this.activities);
	}

	getSnapshot(): ApplicationSnapshot {
		this.assertOpen();
		this.attach();
		return this.snapshot();
	}
	subscribeState(listener: (snapshot: ApplicationSnapshot) => void): () => void {
		this.assertOpen();
		this.attach();
		return this.delivery.subscribeState(listener);
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
	/** The same semantic events consumed by remote interfaces, delivered synchronously for terminal rendering. */
	subscribe(listener: (event: ApplicationEvent) => void): () => void {
		this.attach();
		return this.delivery.subscribe(listener);
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
	subscribeNative(listener: AgentSessionEventListener): () => void {
		this.attach();
		return this.delivery.subscribeNative(listener);
	}
	invoke<K extends Method>(operation: K, ...args: Args<K>): Result<K> {
		if (this.disposed) throw new Error("Application service is closed");
		const method = this.session[operation] as (...parameters: Args<K>) => Result<K>;
		return method.apply(this.session, args);
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
		const images = commandImages(command, this.transcript.assets);
		if (this.state.getState().receipts.size >= 1000)
			throw new Error("Command receipt capacity reached; start a new session");
		const receiptStore = this.receiptStore;
		const recorded = receiptStore?.begin(command);
		if (recorded && !recorded.fresh) return recorded.receipt;
		const receipt: ApplicationReceipt = recorded?.receipt ?? {
			id: command.id,
			status: "accepted",
		};
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
			invoke: () =>
				command.action === "abort"
					? this.invoke("abort")
					: command.action === "prompt"
						? this.invoke("prompt", command.text, { images })
						: this.invoke(command.action, command.text, images),
			publishDomain: (event) => this.publishDomain(event),
		});
		return { ...receipt };
	}
	private project(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_end":
			case "message_update":
				this.transcript.message(event, (value) => {
					this.publish(value);
					return !this.disposed;
				});
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
		this.clearReplay();
		this.sourceMessages = [];
		this.receiptStore = undefined;
		this.onDispose?.(this);
	}
}
