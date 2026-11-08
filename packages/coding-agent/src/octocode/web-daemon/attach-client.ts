import { randomBytes } from "node:crypto";
import net from "node:net";
import { Value } from "typebox/value";
import {
	ATTACH_MAX_EVENT_BYTES,
	ATTACH_MAX_RESPONSE_BYTES,
	ATTACH_PROTOCOL_VERSION,
	AttachEventSchema,
	AttachHelloResultSchema,
	AttachResponseSchema,
	type AttachEvent,
	type AttachRecord,
} from "@octocodeai/octocode-contracts/daemon";
import type {
	ApplicationCommand,
	ApplicationConnection,
	ApplicationCursor,
	ApplicationFrame,
	ApplicationHistory,
	ApplicationPort,
	ApplicationReceipt,
} from "@octocodeai/octocode-contracts";
import type { ChromeTrace } from "../profiler/trace.ts";
import type {
	ProfileAgents,
	ProfileInsights,
	ProfileRequests,
	ProfileTimeline,
	ProfileUpdate,
} from "@octocodeai/octocode-contracts/profiler";
import type { WorkspaceCommand, WorkspaceReceipt, WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { LineReader } from "./lines.ts";

const CONNECT_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Frames a slow tab may leave unread before its stream is replaced by one resync. */
export const STREAM_QUEUE_FRAMES = 512;
/** Bytes a slow tab may leave unread (the sum of its queued frames' lines) before the same happens. */
export const STREAM_QUEUE_BYTES = 8 * 1024 * 1024;

/** A frame stream bounded at `STREAM_QUEUE_FRAMES` frames and `STREAM_QUEUE_BYTES` bytes: past either the backlog is dropped and the tab resynchronizes. */
class FrameStream implements ApplicationConnection {
	private readonly queue: Array<{ frame: ApplicationFrame; bytes: number }> = [];
	private queuedBytes = 0;
	private waiter: (() => void) | undefined;
	private ended = false;
	private cursor: ApplicationCursor;
	private readonly release: (stream: FrameStream, remoteStillOpen: boolean) => void;
	private readonly run: (command: ApplicationCommand) => Promise<ApplicationReceipt>;
	constructor(
		cursor: ApplicationCursor,
		release: (stream: FrameStream, remoteStillOpen: boolean) => void,
		run: (command: ApplicationCommand) => Promise<ApplicationReceipt>,
	) {
		this.cursor = cursor;
		this.release = release;
		this.run = run;
	}

	push(frame: ApplicationFrame, bytes: number): void {
		if (this.ended) return;
		const next = (frame as { cursor?: ApplicationCursor }).cursor;
		if (next) this.cursor = next;
		if (this.queue.length >= STREAM_QUEUE_FRAMES || this.queuedBytes + bytes > STREAM_QUEUE_BYTES)
			return this.overflow();
		this.queue.push({ frame, bytes });
		this.queuedBytes += bytes;
		this.wake();
	}

	/** Drops what is queued, leaves one resync and releases the remote stream; only this stream is affected. */
	overflow(): void {
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.resync("overflow");
		this.release(this, true);
	}

	/** Ends the stream after the frames already queued, with one resync first when `reason` is given. */
	resync(reason: "overflow" | "session-changed"): void {
		if (this.ended) return;
		this.queue.push({
			frame: { protocolVersion: 1, cursor: this.cursor, at: Date.now(), type: "resync", reason },
			bytes: 0,
		});
		this.end();
	}

	end(): void {
		this.ended = true;
		this.wake();
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<ApplicationFrame> {
		for (;;) {
			const next = this.queue.shift();
			if (next) {
				this.queuedBytes -= next.bytes;
				yield next.frame;
			} else if (this.ended) return;
			else await new Promise<void>((resolve) => (this.waiter = resolve));
		}
	}

	execute(command: ApplicationCommand): Promise<ApplicationReceipt> {
		return this.run(command);
	}

	close(): void {
		if (this.ended) return;
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.end();
		this.release(this, true);
	}
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * The daemon's connection to one session's attach endpoint. It never runs agent work: every call is a request the
 * session answers under its own permissions. A closed socket is a detach; the registry attaches again while the
 * session's record stays valid.
 */
export class AttachClient {
	readonly sessionId: string;
	private readonly socket: net.Socket;
	private readonly pending = new Map<string, Pending>();
	private readonly streams = new Map<string, FrameStream>();
	private readonly changeListeners = new Set<() => void>();
	private readonly profilerListeners = new Set<(update: ProfileUpdate) => void>();
	private readonly closeListeners = new Set<(sessionEnded: boolean) => void>();
	private ended = false;
	private sessionEnded = false;
	private sequence = 0;

	private constructor(socket: net.Socket, sessionId: string) {
		this.socket = socket;
		this.sessionId = sessionId;
		const reader = new LineReader(
			ATTACH_MAX_RESPONSE_BYTES,
			(line) => this.accept(line),
			() => this.close(),
		);
		socket.on("data", (chunk) => reader.push(chunk));
		socket.on("close", () => this.finish());
		socket.on("error", () => socket.destroy());
	}

	/** Connects, says hello with the record's token and checks the answer; rejects when the session refuses or is gone. */
	static async connect(record: AttachRecord): Promise<AttachClient> {
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const connection = net.connect({ host: "127.0.0.1", port: record.port });
			const timer = setTimeout(() => connection.destroy(new Error("Attach timed out")), CONNECT_TIMEOUT_MS);
			connection.once("connect", () => {
				clearTimeout(timer);
				connection.off("error", reject);
				resolve(connection);
			});
			connection.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		socket.setNoDelay(true);
		const client = new AttachClient(socket, record.sessionId);
		try {
			const hello = await client.request("attach.hello", {
				token: record.token,
				protocolVersion: ATTACH_PROTOCOL_VERSION,
			});
			if (!Value.Check(AttachHelloResultSchema, hello) || hello.sessionId !== record.sessionId)
				throw new Error("Unexpected attach answer");
		} catch (error) {
			client.close();
			throw error;
		}
		return client;
	}

	get connected(): boolean {
		return !this.ended;
	}

	onWorkspaceChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	/** `sessionEnded` is true when the session said goodbye (as opposed to a dropped socket). */
	onClose(listener: (sessionEnded: boolean) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		if (this.ended) return Promise.reject(new Error("The session is no longer attached."));
		const id = String(++this.sequence);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("The session did not answer in time."));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.socket.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
		});
	}

	/** An unsolicited line over the event cap: the stream it names resynchronizes; an unreadable one ends the connection. */
	private oversizedEvent(line: string): void {
		const id = /^\{"event":"application\.frame","streamId":"([^"\\]{1,64})"/.exec(line.slice(0, 200))?.[1];
		const stream = id === undefined ? undefined : this.streams.get(id);
		if (!stream) return this.close();
		stream.overflow();
	}

	private accept(line: string): void {
		const bytes = Buffer.byteLength(line);
		if (bytes > ATTACH_MAX_EVENT_BYTES && line.startsWith('{"event"')) return this.oversizedEvent(line);
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return this.close();
		}
		if (Value.Check(AttachResponseSchema, message)) {
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.ok) entry.resolve(message.result);
			else entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
			return;
		}
		if (!Value.Check(AttachEventSchema, message)) return;
		this.event(message, bytes);
	}

	private event(event: AttachEvent, bytes: number): void {
		switch (event.event) {
			case "application.frame":
				this.streams.get(event.streamId)?.push(event.frame as ApplicationFrame, bytes);
				return;
			case "application.end": {
				const stream = this.streams.get(event.streamId);
				this.streams.delete(event.streamId);
				stream?.end();
				return;
			}
			case "workspace.changed":
				for (const listener of this.changeListeners) listener();
				return;
			case "profiler.update":
				for (const listener of this.profilerListeners) listener(event.data as ProfileUpdate);
				return;
			case "session.closed":
				this.sessionEnded = true;
		}
	}

	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("The session is no longer attached."));
		}
		this.pending.clear();
		for (const stream of this.streams.values()) stream.resync("session-changed");
		this.streams.clear();
		for (const listener of this.closeListeners) listener(this.sessionEnded);
	}

	close(): void {
		this.socket.destroy();
		this.finish();
	}

	/** The session's application port as the daemon's tabs and HTTP handlers use it. */
	readonly application: ApplicationPort = {
		connect: (options) => {
			const streamId = randomBytes(8).toString("hex");
			const stream = new FrameStream(
				options?.cursor ?? { sessionId: this.sessionId, epoch: "", sequence: 0 },
				(each, remoteStillOpen) => {
					for (const [id, value] of this.streams) if (value === each) this.streams.delete(id);
					if (remoteStillOpen && !this.ended)
						void this.request("application.disconnect", { streamId }).catch(() => undefined);
				},
				(command) => this.execute(command),
			);
			this.streams.set(streamId, stream);
			this.request("application.connect", { streamId, ...(options?.cursor ? { cursor: options.cursor } : {}) }).catch(
				() => {
					this.streams.delete(streamId);
					stream.resync("session-changed");
				},
			);
			return stream;
		},
		execute: (command) => this.execute(command),
		readAsset: (id) => this.request("application.readAsset", { id }),
		history: (options) =>
			this.request<ApplicationHistory>("application.history", {
				...(options?.before ? { before: options.before } : {}),
				...(options?.activityBefore ? { activityBefore: options.activityBefore } : {}),
				...(options?.limit ? { limit: options.limit } : {}),
			}),
	};

	private execute(command: ApplicationCommand): Promise<ApplicationReceipt> {
		return this.request<ApplicationReceipt>("application.execute", { command });
	}

	/** The session's cache profiler; `onUpdate` receives live frames once `subscribe` was asked (the session sends them only then). */
	readonly profiler = {
		agents: () => this.request<ProfileAgents>("profiler.agents"),
		requests: (agentId: string, after?: number, detail?: boolean) =>
			this.request<ProfileRequests | null>("profiler.requests", {
				agentId,
				...(after === undefined ? {} : { after }),
				...(detail ? { detail } : {}),
			}).then((found) => found ?? undefined),
		timeline: (since?: number) =>
			this.request<ProfileTimeline>("profiler.timeline", since === undefined ? {} : { since }),
		insights: () => this.request<ProfileInsights>("profiler.insights"),
		trace: () => this.request<ChromeTrace>("profiler.trace"),
		subscribe: () => this.request("profiler.subscribe"),
		/** Stops the session's frames and its transcript poll; the daemon asks once the last tab of the session is gone. */
		unsubscribe: () => this.request("profiler.unsubscribe"),
		onUpdate: (listener: (update: ProfileUpdate) => void) => {
			this.profilerListeners.add(listener);
			return () => this.profilerListeners.delete(listener);
		},
	};

	readonly workspace = {
		snapshot: () => this.request<WorkspaceSnapshot>("workspace.snapshot"),
		execute: (command: WorkspaceCommand) => this.request<WorkspaceReceipt>("workspace.execute", { command }),
		revision: () => this.request<string | null>("workspace.revision"),
		subscribe: () => this.request("workspace.subscribe"),
	};
}
