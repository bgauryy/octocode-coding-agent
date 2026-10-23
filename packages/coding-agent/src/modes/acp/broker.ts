import { randomUUID } from "node:crypto";
import {
	agent,
	methods,
	PROTOCOL_VERSION,
	RequestError,
	type AgentConnection,
	type AgentContext,
	type McpServer,
	type Stream,
} from "@agentclientprotocol/sdk";
import { VERSION } from "../../config.ts";
import { AcpSession, type AcpWorker } from "./session.ts";
import { canonicalDirectory, findHistory, listHistory, replayHistory } from "./history.ts";

export type { AcpWorker } from "./session.ts";
export interface AcpBrokerOptions {
	createWorker: (cwd: string, mcpServers: McpServer[]) => Promise<AcpWorker>;
	maxSessions?: number;
	cancelTimeoutMs?: number;
	sessionDir?: string;
}

/** ACP v1 presentation adapter. Execution and policy stay in isolated native workers. */
export class AcpBroker {
	private connection?: AgentConnection;
	private initialized = false;
	private closing?: Promise<void>;
	private stopped = false;
	private readonly sessions = new Map<string, AcpSession>();
	private readonly restoring = new Set<string>();
	private readonly pending = new Set<Promise<unknown>>();
	private creating = 0;
	private readonly options: AcpBrokerOptions;
	constructor(options: AcpBrokerOptions) {
		this.options = options;
	}

	connect(stream: Stream): AgentConnection {
		if (this.connection || this.stopped) throw new Error("ACP broker is already connected or closed");
		const app = agent({ name: "octocode" })
			.onRequest(methods.agent.initialize, () => {
				if (this.initialized) throw RequestError.invalidRequest(undefined, "Already initialized.");
				this.initialized = true;
				return {
					protocolVersion: PROTOCOL_VERSION,
					agentInfo: { name: "octocode", version: VERSION },
					authMethods: [],
					agentCapabilities: {
						loadSession: true,
						sessionCapabilities: { close: {}, resume: {}, list: {} },
						promptCapabilities: { image: true, embeddedContext: true },
						mcpCapabilities: { http: true, sse: true },
					},
				};
			})
			.onRequest(methods.agent.session.new, ({ params, client }) => {
				this.ready();
				if (params.additionalDirectories?.length)
					throw RequestError.invalidParams(undefined, "Additional workspace directories are unsupported.");
				const work = this.createSession(params.cwd, params.mcpServers, client);
				this.pending.add(work);
				void work.finally(() => this.pending.delete(work)).catch(() => {});
				return work;
			})
			.onRequest(methods.agent.session.load, ({ params, client }) => {
				this.ready();
				if (params.additionalDirectories?.length)
					throw RequestError.invalidParams(undefined, "Additional workspace directories are unsupported.");
				const work = this.restoreSession(params.cwd, params.sessionId, params.mcpServers, client, true);
				this.pending.add(work);
				void work.finally(() => this.pending.delete(work)).catch(() => {});
				return work;
			})
			.onRequest(methods.agent.session.resume, ({ params, client }) => {
				this.ready();
				if (params.additionalDirectories?.length)
					throw RequestError.invalidParams(undefined, "Additional workspace directories are unsupported.");
				const work = this.restoreSession(params.cwd, params.sessionId, params.mcpServers ?? [], client, false);
				this.pending.add(work);
				void work.finally(() => this.pending.delete(work)).catch(() => {});
				return work;
			})
			.onRequest(methods.agent.session.list, ({ params }) => {
				this.ready();
				return listHistory(params.cwd ?? undefined, params.cursor ?? undefined, this.options.sessionDir);
			})
			.onRequest(methods.agent.session.prompt, ({ params }) => this.get(params.sessionId).prompt(params.prompt))
			.onNotification(methods.agent.session.cancel, ({ params }) => this.get(params.sessionId).cancel())
			.onRequest(methods.agent.session.close, async ({ params }) => {
				const session = this.get(params.sessionId);
				await session.release();
				this.sessions.delete(params.sessionId);
				return {};
			});
		this.connection = app.connect(stream);
		this.connection.signal.addEventListener(
			"abort",
			() => {
				void this.close();
			},
			{ once: true },
		);
		return this.connection;
	}

	private ready(): void {
		if (!this.initialized || this.stopped)
			throw RequestError.invalidRequest(undefined, "Initialize an open connection first.");
	}
	private get(id: string): AcpSession {
		this.ready();
		const session = this.sessions.get(id);
		if (!session) throw RequestError.resourceNotFound(id);
		return session;
	}
	private async restoreSession(
		cwd: string,
		id: string,
		servers: McpServer[],
		client: AgentContext,
		replay: boolean,
	): Promise<Record<string, never>> {
		if (this.sessions.has(id) || this.restoring.has(id))
			throw RequestError.invalidRequest(undefined, "Session is already active or restoring.");
		this.restoring.add(id);
		try {
			const info = await findHistory(id, cwd, this.options.sessionDir);
			await this.createSession(cwd, servers, client, info.path, id, replay);
			return {};
		} finally {
			this.restoring.delete(id);
		}
	}

	private async createSession(
		cwd: string,
		servers: McpServer[],
		client: AgentContext,
		path?: string,
		expectedId?: string,
		replay = false,
	): Promise<{ sessionId: string }> {
		if (this.sessions.size + this.creating >= (this.options.maxSessions ?? 8))
			throw RequestError.invalidRequest(
				undefined,
				"Session limit reached; close a session or start another agent process.",
			);
		if (expectedId && this.sessions.has(expectedId))
			throw RequestError.invalidRequest(undefined, "Session is already active; close it before restoring.");
		this.creating++;
		let counted = true;
		let session: AcpSession | undefined;
		try {
			const directory = await canonicalDirectory(cwd);
			const worker = await this.options.createWorker(directory, servers);
			if (this.stopped) {
				await worker.stop();
				throw RequestError.invalidRequest(undefined, "Connection closed during startup.");
			}
			session = new AcpSession(
				expectedId ?? randomUUID(),
				worker,
				client,
				this.options.cancelTimeoutMs ?? 5_000,
				() => {
					if (session && this.sessions.get(session.id) === session) this.sessions.delete(session.id);
				},
			);
			const id = await session.start(expectedId, path);
			if (this.sessions.has(id)) throw RequestError.invalidRequest(undefined, "Session is already active.");
			session.id = id;
			if (replay && path) await replayHistory(path, id, client);
			if (this.stopped) throw RequestError.invalidRequest(undefined, "Connection closed during startup.");
			if (session.isClosed()) throw RequestError.internalError(undefined, "Agent process closed during startup.");
			this.sessions.set(id, session);
			this.creating--;
			counted = false;
			return { sessionId: session.id };
		} catch (error) {
			if (session) {
				this.sessions.delete(session.id);
				await session.close();
			}
			if (counted) this.creating--;
			if (error instanceof RequestError) throw error;
			throw RequestError.internalError(undefined, "Could not start the Octocode session. See agent stderr.");
		}
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.stopped = true;
		this.closing = (async () => {
			await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
			await Promise.allSettled(this.pending);
			this.sessions.clear();
			this.connection?.close();
		})();
		return this.closing;
	}
}
