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
import { redactSecrets } from "../../../common/src/sanitize.ts";
import type { AcpBrokerHost } from "../host.ts";
import { AcpSession, type AcpWorker } from "./session.ts";
import { canonicalDirectory, findHistory, listHistory, prepareHistoryReplay, sessionNotFound } from "./history.ts";
import { reportToStderr } from "../../../common/src/stderr.ts";

export type { AcpWorker } from "./session.ts";
/**
 * The code for a session in a folder the user has not trusted. ACP's `-32002` means the resource does not exist, and it
 * reserves -32768 to -32000 for JSON-RPC and itself; a client treats a code it does not know as a generic failure and
 * shows the message.
 */
const FOLDER_NOT_TRUSTED = -31000;

interface AcpBrokerOptions {
	host: AcpBrokerHost;
	createWorker: (cwd: string, mcpServers: McpServer[], sessionPath?: string) => Promise<AcpWorker>;
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
	private readonly startups = new Set<AcpSession>();
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
					agentInfo: { name: "octocode", version: this.options.host.version },
					authMethods: [],
					agentCapabilities: {
						loadSession: true,
						sessionCapabilities: { close: {}, resume: {}, list: {} },
						promptCapabilities: { image: true, embeddedContext: true },
						mcpCapabilities: { http: true, sse: false },
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
				return listHistory(
					this.options.host,
					params.cwd ?? undefined,
					params.cursor ?? undefined,
					this.options.sessionDir,
				);
			})
			.onRequest(methods.agent.session.prompt, ({ params, signal }) => {
				const session = this.get(params.sessionId);
				const done = session.prompt(params.prompt);
				// `$/cancel_request` on the prompt asks for what `session/cancel` asks for; the prompt then answers `cancelled`.
				signal.addEventListener(
					"abort",
					() => {
						void session.cancel().catch((error: unknown) => reportToStderr("ACP cancellation failed", error));
					},
					{ once: true },
				);
				return done;
			})
			// A cancel can cross the close of its session on the wire, so an unknown session is not a failure.
			.onNotification(methods.agent.session.cancel, async ({ params }) => {
				this.ready();
				await this.sessions.get(params.sessionId)?.cancel();
			})
			.onRequest(methods.agent.session.close, async ({ params }) => {
				this.ready();
				// Closing a session that does not exist still succeeds.
				await this.sessions.get(params.sessionId)?.release();
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
		if (this.restoring.has(id)) throw RequestError.invalidRequest(undefined, "Session is restoring.");
		const session = this.sessions.get(id);
		if (!session) throw sessionNotFound(id);
		return session;
	}
	private async restoreSession(
		cwd: string,
		id: string,
		servers: McpServer[],
		client: AgentContext,
		replay: boolean,
	): Promise<Record<string, never>> {
		if (this.restoring.has(id)) throw RequestError.invalidRequest(undefined, "Session is already restoring.");
		this.restoring.add(id);
		try {
			const info = await findHistory(this.options.host, id, cwd, this.options.sessionDir);
			const active = this.sessions.get(id);
			if (active) {
				if (active.isBusy()) throw RequestError.invalidRequest(undefined, "Session is busy; nothing was replaced.");
				// Recreate an idle worker so the client's current MCP definitions take effect.
				await active.release();
				if (this.sessions.get(id) === active) this.sessions.delete(id);
			}
			this.ready();
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
			const trust = this.options.host.folderTrust(directory);
			if (!trust.trusted)
				throw new RequestError(FOLDER_NOT_TRUSTED, trust.message, { path: directory, command: trust.command });
			const replaySaved =
				replay && path && expectedId ? prepareHistoryReplay(this.options.host, path, expectedId, client) : undefined;
			const worker = await this.options.createWorker(directory, servers, path);
			if (this.stopped) {
				await worker.stop();
				throw RequestError.invalidRequest(undefined, "Connection closed during startup.");
			}
			session = new AcpSession(
				expectedId ?? randomUUID(),
				worker,
				client,
				this.options.cancelTimeoutMs ?? 5_000,
				(summary, tokensBefore) => this.options.host.compactionSummaryText(summary, tokensBefore),
				() => {
					if (session && this.sessions.get(session.id) === session) this.sessions.delete(session.id);
				},
			);
			const owned = session;
			this.startups.add(owned);
			await owned.start(expectedId, async (id) => {
				if (this.sessions.has(id)) throw RequestError.invalidRequest(undefined, "Session is already active.");
				if (this.stopped || owned.isClosed()) throw new Error("Session closed during startup.");
				this.sessions.set(id, owned);
				this.startups.delete(owned);
				this.creating--;
				counted = false;
				await replaySaved?.();
			});
			if (this.stopped || owned.isClosed()) throw new Error("Session closed during startup.");
			return { sessionId: session.id };
		} catch (error) {
			if (session) {
				if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
				this.startups.delete(session);
				await session.close();
			}
			if (counted) this.creating--;
			if (error instanceof RequestError) throw error;
			// The worker's own words say what to do: another process has this session open, a settings file is broken.
			const reason = error instanceof Error ? `: ${redactSecrets(error.message)}` : ". See agent stderr.";
			throw RequestError.internalError(undefined, `Could not start the Octocode session${reason}`);
		}
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.stopped = true;
		this.closing = (async () => {
			await Promise.allSettled([...this.startups, ...this.sessions.values()].map((session) => session.close()));
			await Promise.allSettled(this.pending);
			this.sessions.clear();
			this.connection?.close();
		})();
		return this.closing;
	}
}
