import { randomBytes } from "node:crypto";
import { sameSecret } from "@octocodeai/octocode-common/env";
import net, { type AddressInfo } from "node:net";
import { Value } from "typebox/value";
import {
	ATTACH_MAX_EVENT_BYTES,
	ATTACH_MAX_REQUEST_BYTES,
	ATTACH_MAX_RESPONSE_BYTES,
	ATTACH_PROTOCOL_VERSION,
	AttachRequestSchema,
	type AttachEvent,
	type AttachRecord,
	type AttachRequest,
	type AttachResponse,
	type AttachToolStates,
} from "@octocodeai/octocode-contracts/daemon";
import type { ApplicationConnection, ApplicationFrame } from "@octocodeai/octocode-contracts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { processStartTime } from "../shared/process.ts";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import type { RevisedWorkspace } from "../workspace/revision.ts";
import { LineReader } from "@octocodeai/octocode-common/line-splitter";
import { attachRecordPath, webDaemonPaths } from "./paths.ts";
import { removeRecord, sweepAttachRecords, writeAttachRecord } from "./records.ts";

/** A peer that has not said hello by now is dropped: unauthenticated sockets are cheap for a stranger to open. */
const HELLO_TIMEOUT_MS = 2000;
/** Authenticated daemon connections. Unauthenticated sockets do not count against it. */
const MAX_CONNECTIONS = 8;
/** Sockets waiting for their hello; when full the oldest is dropped, so a stranger cannot keep the daemon out. */
const MAX_PENDING = 16;
const MAX_STREAMS = 32;

export interface AttachSource {
	sessionId: string;
	cwd: string;
	repo: AttachRecord["repo"];
	/** The session's workspace connection (application port, snapshot, commands and change subscription). */
	workspace: RevisedWorkspace;
	/** What this session declares of each tool, for the Tools panel of its page; absent: the session cannot say. */
	tools?: () => AttachToolStates;
	/** Repaints what the session shows of its board (the footer counts) after the daemon changed the board. */
	boardChanged?: () => void;
}

export interface AttachEndpoint {
	readonly sessionId: string;
	readonly port: number;
	close(): Promise<void>;
}

/** Everything a request needs from the daemon's connection, so the handler stays a plain function of the session. */
interface Peer {
	streams: Map<string, ApplicationConnection>;
	unsubscribe?: () => void;
	unsubscribeProfiler?: () => void;
	/** Writes one line; false when an unsolicited event would pass the event cap (nothing is written then). */
	send(message: AttachResponse | AttachEvent): boolean;
}

function failure(id: string, code: string, message: string): AttachResponse {
	return { id, ok: false, error: { code, message: redactSecrets(message).slice(0, 2000) } };
}

function startStream(source: AttachSource, peer: Peer, streamId: string, cursor: unknown): void {
	const application = source.workspace.application;
	if (!application) throw new Error("Application controls are unavailable in this session.");
	if (peer.streams.has(streamId) || peer.streams.size >= MAX_STREAMS) throw new Error("Too many open streams.");
	const connection = application.connect({ sessionId: source.sessionId, cursor: cursor as never });
	peer.streams.set(streamId, connection);
	// The answer goes out first; frames follow after it.
	const forward = async () => {
		try {
			for await (const frame of connection) {
				if (peer.streams.get(streamId) !== connection) break;
				if (peer.send({ event: "application.frame", streamId, frame })) continue;
				// A frame over the event cap is never sent: the stream resynchronizes instead, and no other stream is touched.
				const cursor = (frame as { cursor?: ApplicationFrame["cursor"] }).cursor ?? {
					sessionId: source.sessionId,
					epoch: "",
					sequence: 0,
				};
				peer.send({
					event: "application.frame",
					streamId,
					frame: { protocolVersion: 1, cursor, at: Date.now(), type: "resync", reason: "overflow" },
				});
				break;
			}
		} catch {
			// The stream ends; the daemon's tab reconnects and resynchronizes.
		} finally {
			if (peer.streams.get(streamId) === connection) {
				peer.streams.delete(streamId);
				connection.close();
				peer.send({ event: "application.end", streamId });
			}
		}
	};
	setImmediate(() => void forward());
}

async function answer(source: AttachSource, peer: Peer, request: AttachRequest): Promise<unknown> {
	const { workspace } = source;
	switch (request.method) {
		case "attach.hello":
			return undefined;
		case "application.connect":
			return startStream(source, peer, request.params.streamId, request.params.cursor);
		case "application.disconnect": {
			const connection = peer.streams.get(request.params.streamId);
			peer.streams.delete(request.params.streamId);
			connection?.close();
			return undefined;
		}
		case "application.execute":
			if (!workspace.application) throw new Error("Application controls are unavailable in this session.");
			return workspace.application.execute(request.params.command);
		case "application.readAsset":
			return workspace.application?.readAsset?.(request.params.id, source.sessionId);
		case "application.history":
			if (!workspace.application?.history) throw new Error("History is unavailable in this session.");
			return workspace.application.history({ ...request.params, sessionId: source.sessionId });
		case "workspace.snapshot":
			return workspace.snapshot();
		case "workspace.revision":
			return workspace.revision?.() ?? null;
		case "workspace.subscribe":
			peer.unsubscribe ??= workspace.subscribe(() => peer.send({ event: "workspace.changed" }));
			return undefined;
		case "profiler.agents":
			if (!workspace.profiler) throw new Error("The profiler is unavailable in this session.");
			return workspace.profiler.agents();
		case "profiler.requests":
			if (!workspace.profiler) throw new Error("The profiler is unavailable in this session.");
			return workspace.profiler.requests(request.params.agentId, request.params.after, request.params.detail) ?? null;
		case "profiler.timeline":
		case "profiler.insights":
		case "profiler.trace": {
			if (!workspace.profiler) throw new Error("The profiler is unavailable in this session.");
			if (request.method === "profiler.insights") return workspace.profiler.insights();
			if (request.method === "profiler.trace") return workspace.profiler.trace();
			return workspace.profiler.timeline(request.params.since);
		}
		case "profiler.subscribe":
			peer.unsubscribeProfiler ??= workspace.profiler?.subscribe((data) =>
				peer.send({ event: "profiler.update", data }),
			);
			return undefined;
		case "profiler.unsubscribe":
			peer.unsubscribeProfiler?.();
			peer.unsubscribeProfiler = undefined;
			return undefined;
		case "workspace.execute":
			return workspace.execute(request.params.command);
		case "session.tools":
			if (!source.tools) throw new Error("Tool states are unavailable in this session.");
			return source.tools();
		case "backlog.changed":
			source.boardChanged?.();
			return undefined;
	}
}

/**
 * The session's owner-only attach endpoint: loopback TCP, newline-delimited JSON, one capability per session run
 * (32 random bytes in `attach/<sessionId>.json`, mode 0600). The first request on a connection must be `attach.hello`
 * with that token; anything else closes it. The endpoint adds no authority: it calls the same application port and
 * workspace connection the in-process server uses, so permissions and execution stay in this process.
 */
export async function startAttachServer(
	source: AttachSource,
	env: NodeJS.ProcessEnv = process.env,
): Promise<AttachEndpoint> {
	const token = randomBytes(32).toString("hex");
	interface Entry {
		socket: net.Socket;
		peer: Peer;
	}
	const peers = new Set<Entry>();
	const pending = new Set<Entry>();
	const server = net.createServer((socket) => {
		// Nothing a peer sends may throw out of a socket handler: a failure ends that socket only.
		socket.on("error", () => socket.destroy());
		socket.setNoDelay(true);
		socket.unref();
		let authenticated = false;
		const send = (message: AttachResponse | AttachEvent): boolean => {
			if (socket.destroyed) return true;
			const line = `${JSON.stringify(message)}\n`;
			if ("event" in message && Buffer.byteLength(line) > ATTACH_MAX_EVENT_BYTES) return false;
			if (socket.writableLength > ATTACH_MAX_RESPONSE_BYTES) socket.destroy();
			else socket.write(line);
			return true;
		};
		const peer: Peer = { streams: new Map(), send };
		const entry: Entry = { socket, peer };
		if (pending.size >= MAX_PENDING) {
			const oldest = pending.values().next().value;
			if (oldest) {
				pending.delete(oldest);
				oldest.socket.destroy();
			}
		}
		pending.add(entry);
		const timeout = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
		timeout.unref();
		const refuse = (id: string, code: string, message: string) => {
			send(failure(id, code, message));
			socket.end();
		};
		const handle = (line: string) => {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				return socket.destroy();
			}
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return socket.destroy();
			const message = raw as { id?: unknown; method?: unknown; params?: unknown };
			const id = typeof message.id === "string" ? message.id : "";
			if (!authenticated) {
				const params =
					typeof message.params === "object" && message.params !== null
						? (message.params as Record<string, unknown>)
						: {};
				if (message.method !== "attach.hello" || typeof params.token !== "string")
					return refuse(id, "unauthorized", "Say attach.hello first.");
				if (!sameSecret(token, params.token)) return refuse(id, "unauthorized", "Wrong attach token.");
				if (params.protocolVersion !== ATTACH_PROTOCOL_VERSION)
					return refuse(id, "protocol", "Unsupported attach protocol; restart this session to connect.");
				if (peers.size >= MAX_CONNECTIONS) return refuse(id, "busy", "Too many daemon connections.");
				authenticated = true;
				clearTimeout(timeout);
				pending.delete(entry);
				peers.add(entry);
				send({
					id,
					ok: true,
					result: {
						sessionId: source.sessionId,
						protocolVersion: ATTACH_PROTOCOL_VERSION,
						capabilities: [
							...(source.workspace.application ? ["application"] : []),
							"workspace",
							...(source.workspace.profiler ? ["profiler"] : []),
							...(source.tools ? ["tools"] : []),
						],
					},
				});
				return;
			}
			if (!Value.Check(AttachRequestSchema, raw)) return void send(failure(id, "invalid", "Invalid attach request."));
			const request = raw;
			void answer(source, peer, request).then(
				(result) => send({ id: request.id, ok: true, ...(result === undefined ? {} : { result }) }),
				(error: unknown) => send(failure(request.id, "failed", errorMessage(error))),
			);
		};
		const reader = new LineReader(
			ATTACH_MAX_REQUEST_BYTES,
			(line) => {
				try {
					handle(line);
				} catch {
					socket.destroy();
				}
			},
			() => socket.destroy(),
		);
		socket.on("data", (chunk) => {
			try {
				reader.push(chunk);
			} catch {
				socket.destroy();
			}
		});
		socket.on("close", () => {
			clearTimeout(timeout);
			peers.delete(entry);
			pending.delete(entry);
			peer.unsubscribe?.();
			peer.unsubscribeProfiler?.();
			for (const connection of peer.streams.values()) connection.close();
			peer.streams.clear();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	const port = (server.address() as AddressInfo).port;
	// Records of sessions killed without their shutdown never go away on their own.
	await sweepAttachRecords(webDaemonPaths(env).attachDir);
	const file = attachRecordPath(env, source.sessionId);
	const record: AttachRecord = {
		protocolVersion: ATTACH_PROTOCOL_VERSION,
		sessionId: source.sessionId,
		pid: process.pid,
		...(processStartTime(process.pid) ? { pid_started: processStartTime(process.pid) } : {}),
		port,
		token,
		cwd: source.cwd,
		repo: source.repo,
		startedAt: Date.now(),
	};
	try {
		writeAttachRecord(file, record);
	} catch (error) {
		server.close();
		throw error;
	}
	let closing: Promise<void> | undefined;
	return {
		sessionId: source.sessionId,
		port,
		close: () =>
			(closing ??= new Promise<void>((resolve) => {
				removeRecord(file, (text) => text.includes(token));
				for (const { socket, peer } of [...peers, ...pending]) {
					peer.send({ event: "session.closed" });
					socket.end();
				}
				server.close(() => resolve());
				// Give the farewell line a moment to flush, then drop whatever is left.
				setTimeout(() => {
					for (const { socket } of [...peers, ...pending]) socket.destroy();
				}, 200).unref();
			})),
	};
}
