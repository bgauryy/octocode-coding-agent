import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { contentText, isStaleSessionError } from "../shared/util.ts";
import { toolHint } from "../../utils/tool-hint.ts";
import { abortTurn } from "./bridge/abort.ts";
import { boundedText } from "./bridge/bounded.ts";
import type { ExternalFacts } from "./bridge/caller.ts";
import { TurnCeilings } from "./bridge/ceiling.ts";
import { callExternal } from "./bridge/external-call.ts";
import { type AgentDirectory, type ApiOperations, nesting } from "./bridge/contracts.ts";
import { historyPage } from "./bridge/history.ts";
import type { ApiOptions } from "./bridge/options.ts";
import { recordRead } from "./bridge/reads.ts";
import { registerExternalMessageRenderer } from "./bridge/renderer.ts";
import { sendMessage } from "./bridge/send.ts";
import { tellAgent } from "./bridge/tell.ts";
import { verifyCaller } from "./bridge/verify.ts";
import { EventLog } from "./events.ts";
import { confirmIdentity, publishOwnInstance } from "./identity.ts";
import {
	clampedParam,
	DEFAULT_EVENT_TYPES,
	ERR,
	numberParam,
	PROTOCOL_VERSION,
	RpcError,
	stringParam,
} from "./protocol.ts";
import { type RunResult, SendReceipts } from "./receipts.ts";
import {
	apiDir,
	ensurePrivateDir,
	type InstanceRecord,
	listInstances,
	newInstanceId,
	newToken,
	removeRecord,
	socketPath,
	sweepSocketFolders,
	writeRecord,
} from "./registry.ts";
import { ApiServer, type Connection } from "./server.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** Session entry (`api.appendEntry`, never sent to the model) written for every turn an API client starts. */
const EXTERNAL_AUDIT_TYPE = "octocode-external";
/** `messages.list` page size: the default, and the most one page holds (a larger `limit` gets this many; `earlier` reaches the rest). */
const HISTORY_PAGE = 20;
const HISTORY_MAX_PAGE = 100;

/**
 * An external API for one running Octocode session: other programs discover it, send it messages, follow what it does and
 * ask it to stop. JSON-RPC 2.0 over a private Unix socket (and optionally authenticated loopback HTTP + SSE), the
 * shape Codex's app-server and ACP use, scoped to this extension's needs.
 */
export class OctocodeApi {
	readonly log = new EventLog();
	private ctx: ExtensionContext | undefined;
	private server: ApiServer | undefined;
	private record: InstanceRecord | undefined;
	private dir: string;
	/** The last run's final assistant text, handed to `wait` callers when Octocode settles. */
	private lastResult: RunResult | undefined;
	private counter = 0;
	private readonly receipts = new SendReceipts();
	private lastAssistantText = "";
	private pendingDelta = "";

	private readonly api: ExtensionAPI;
	private readonly agents: AgentDirectory;
	private readonly version: () => string | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly operations: ApiOperations;
	/** The `sessionApiTurnPermission` ceiling's owner; `operations` is what it hands back. */
	private readonly ceilings: TurnCeilings;
	constructor(
		api: ExtensionAPI,
		agents: AgentDirectory,
		version: () => string | undefined,
		env: NodeJS.ProcessEnv = process.env,
		operations: ApiOperations = {},
	) {
		this.api = api;
		this.agents = agents;
		this.version = version;
		this.env = env;
		this.ceilings = new TurnCeilings(operations);
		this.operations = this.ceilings.operations;

		this.dir = apiDir(env);
	}

	get running(): boolean {
		return this.server !== undefined;
	}

	get directory(): string {
		return this.dir;
	}

	get instance(): InstanceRecord | undefined {
		return this.record;
	}

	/** Publish Octocode's events to subscribers. Cheap when nobody listens: the log only keeps a short ring buffer. */
	observe(): void {
		const { api, log } = this;
		const flushDelta = (): void => {
			if (!this.pendingDelta) return;
			const delta = boundedText(this.pendingDelta);
			this.pendingDelta = "";
			log.publish("message.delta", { delta });
		};
		registerExternalMessageRenderer(api);
		api.on("agent_start", () => {
			// A new run: `wait` must never answer with the previous run's text.
			this.lastResult = undefined;
			this.pendingDelta = "";
			if (this.server) log.publish("agent.start", {});
		});
		api.on("agent_end", (event) => {
			if (!this.server) return;
			flushDelta();
			const last = [...event.messages].reverse().find((message) => message.role === "assistant");
			const text = last ? contentText(last.content, { separator: "" }) : "";
			const stopReason = last && "stopReason" in last ? last.stopReason : undefined;
			this.lastAssistantText = text;
			this.lastResult = { text: boundedText(text), ...(stopReason ? { stopReason } : {}) };
			log.publish("agent.end", this.lastResult);
		});
		// `wait` answers once Octocode has settled: after agent_end it may still continue (a queued follow-up, a compaction
		// retry), and the caller wants the final answer, not an intermediate one.
		api.on("agent_settled", (event) => {
			this.operations.capTurn?.(undefined); // an API-started turn is over, API running or not
			if (!this.server) return;
			// The recorded outcome decides failure: recovery can remove the failed attempt `agent_end` would have reported.
			const { outcome } = event;
			const failure = outcome && outcome.status !== "completed" ? outcome : undefined;
			const result: RunResult = {
				...(this.lastResult ?? { text: "" }),
				...(event.aborted ? { stopReason: "aborted" } : {}),
				...(failure?.stopReason ? { stopReason: failure.stopReason } : {}),
				...(failure?.errorMessage ? { errorMessage: boundedText(failure.errorMessage) } : {}),
			};
			this.receipts.settle(result);
			log.publish("agent.settled", result);
		});
		api.on("message_end", (event) => {
			if (!this.server) return;
			const { role } = event.message;
			if (role === "assistant") flushDelta();
			if (role === "assistant" || role === "user")
				log.publish("message", { role, text: boundedText(contentText(event.message.content, { separator: "" })) });
		});
		api.on("message_update", (event) => {
			if (!this.server) return;
			const inner = event.assistantMessageEvent as { type?: string; delta?: unknown };
			if (inner.type === "text_delta" && typeof inner.delta === "string") this.pendingDelta += inner.delta;
		});
		api.on("tool_execution_start", (event) => {
			if (!this.server) return;
			log.publish("tool.start", {
				id: event.toolCallId,
				name: event.toolName,
				hint: toolHint(event.args),
				...nesting(event.parentToolCallId),
			});
		});
		api.on("tool_execution_end", (event) => {
			if (!this.server) return;
			log.publish("tool.end", {
				id: event.toolCallId,
				name: event.toolName,
				isError: event.isError,
				...nesting(event.parentToolCallId),
				...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
			});
		});
		api.on("session_compact", () => {
			if (this.server) log.publish("compaction", {});
			return undefined;
		});
	}

	/** Bind to the session, and serve on `options` (undefined: bound, not serving). */
	async start(ctx: ExtensionContext, options: ApiOptions | undefined): Promise<void> {
		await this.stop();
		this.ctx = ctx;
		if (!options) return;
		this.dir = apiDir(this.env);
		ensurePrivateDir(this.dir);
		// Every session publishes a record, and a killed one cannot remove its own: each start sweeps what the dead left.
		listInstances(this.dir);
		void sweepSocketFolders(this.env);
		const id = newInstanceId();
		const token = newToken();
		const server = new ApiServer(
			(method, params, connection) => this.dispatch(method, params, connection),
			this.log,
			token,
			(connection) => this.read("events.subscribe", {}, connection),
		);
		try {
			const record: InstanceRecord = {
				id,
				pid: process.pid,
				cwd: ctx.cwd,
				startedAt: Date.now(),
				protocol: PROTOCOL_VERSION,
				session: ctx.sessionManager.getSessionId(),
				// The process names itself for this session before the API starts (`processes/register.ts`, registered first).
				name: process.title,
			};
			if (options.socket) {
				record.socket = socketPath(this.dir, id, this.env);
				await server.listenUnix(record.socket);
			}
			if (options.http !== undefined) {
				await server.listenHttp(options.http);
				record.http = { url: server.httpUrl!, token };
			}
			this.server = server;
			this.record = record;
			writeRecord(this.dir, record);
			publishOwnInstance(record);
		} catch (error) {
			await server.close();
			throw new Error(`Octocode API could not start: ${errorMessage(error)}`, { cause: error });
		}
	}

	async stop(): Promise<void> {
		const { server, record } = this;
		this.server = undefined;
		this.record = undefined;
		this.ctx = undefined;
		this.lastResult = undefined;
		this.lastAssistantText = "";
		this.pendingDelta = "";
		this.receipts.end();
		publishOwnInstance(undefined, record);
		if (record) removeRecord(this.dir, record.id);
		await server?.close();
		this.log.close();
	}

	private session(): ExtensionContext {
		if (!this.ctx) throw new RpcError(ERR.unavailable, "No active session");
		this.receipts.follow(this.ctx.sessionManager.getSessionId());
		return this.ctx;
	}

	private guardSession(params: Record<string, unknown>, ctx: ExtensionContext): void {
		const expected = stringParam(params, "expectedSessionId", { optional: true });
		if (expected !== undefined && expected !== ctx.sessionManager.getSessionId())
			throw new RpcError(ERR.unavailable, "The expected session was replaced; nothing was sent", {
				execution: "not-sent",
			});
	}

	private status(): Record<string, unknown> {
		const ctx = this.session();
		try {
			const usage = ctx.getContextUsage();
			return {
				state: ctx.isIdle() ? "idle" : "working",
				pending: ctx.hasPendingMessages(),
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName: ctx.sessionManager.getSessionName() ?? null,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
				context: usage ?? null,
				seq: this.log.seq,
				...(this.receipts.activeKey ? { activeMessageId: this.receipts.active()?.accepted.id } : {}),
			};
		} catch (error) {
			// Octocode's own words for a context used after its session was replaced; anything else is a real failure, reported as such.
			if (isStaleSessionError(error)) throw new RpcError(ERR.unavailable, "The session was replaced");
			throw new RpcError(ERR.internal, `The session status could not be read: ${errorMessage(error)}`);
		}
	}

	private async dispatch(method: string, params: Record<string, unknown>, connection: Connection): Promise<unknown> {
		switch (method) {
			case "ping":
				return {};
			case "initialize":
				return {
					protocolVersion: PROTOCOL_VERSION,
					instance: { id: this.record?.id, pid: process.pid, cwd: this.ctx?.cwd, version: this.version() },
					capabilities: {
						events: DEFAULT_EVENT_TYPES,
						optionalEvents: ["message.delta"],
						wait: true,
						agents: true,
						streaming: connection.subscribe !== undefined,
					},
				};
			case "identity.confirm":
				return confirmIdentity(params);
			case "status":
				this.read(method, params, connection);
				return this.status();
			case "message.send":
				return this.send(params, connection);
			case "turn.abort":
				return abortTurn(this.host(connection), params, connection);
			case "external.call":
				return callExternal(this.host(connection), params, connection);
			case "messages.list":
				this.read(method, params, connection);
				return this.history(
					clampedParam(params, "limit", { min: 1, max: HISTORY_MAX_PAGE }) ?? HISTORY_PAGE,
					clampedParam(params, "before", { min: 0, max: Number.MAX_SAFE_INTEGER }),
				);
			case "events.subscribe": {
				if (!connection.subscribe)
					throw new RpcError(ERR.invalidRequest, "Streaming needs the socket transport or GET /events");
				const since = numberParam(params, "since", { min: 0, max: Number.MAX_SAFE_INTEGER });
				const types = params.types;
				if (types !== undefined && (!Array.isArray(types) || types.some((type) => typeof type !== "string")))
					throw new RpcError(ERR.invalidParams, "types must be an array of strings");
				this.read(method, params, connection);
				return connection.subscribe({
					...(since !== undefined ? { since } : {}),
					...(types ? { types: types as string[] } : {}),
				});
			}
			case "events.unsubscribe":
				connection.unsubscribe?.();
				return {};
			case "agents.list":
				this.read(method, params, connection);
				return { agents: this.agents.list() };
			case "agents.tell":
				return tellAgent({ ...this.host(connection), agents: this.agents }, params, connection);
			default:
				throw new RpcError(ERR.methodNotFound, `Unknown method ${method}`);
		}
	}

	/** What `turn.abort`, `external.call` and `agents.tell` (`bridge/`) need of this API for a call on `connection`. */
	private host(connection: Connection) {
		return {
			ceilings: this.ceilings,
			receipts: this.receipts,
			session: () => this.session(),
			guardSession: (given: Record<string, unknown>, ctx: ExtensionContext) => this.guardSession(given, ctx),
			verify: (facts: ExternalFacts, given: Record<string, unknown>) => this.verify(facts, given, connection),
			audit: (data: Record<string, unknown>) => this.audit(data),
		};
	}

	/** The caller's facts, confirmed with the instance it names (`bridge/verify.ts`); `timeoutMs` defaults to the client's own. */
	private verify(facts: ExternalFacts, params: Record<string, unknown>, connection: Connection, timeoutMs?: number) {
		return verifyCaller(facts, params, connection, this.record, timeoutMs);
	}

	/** Records a read (`bridge/reads.ts`): open to any process of this user, and named in the session's record. */
	private read(method: string, params: Record<string, unknown>, connection: Connection): void {
		recordRead((data) => this.audit(data), method, params, connection);
	}

	/** Records what an API client did in the session (a `octocode-external` entry): the turns it started, what it stopped and what it read. */
	private audit(data: Record<string, unknown>): void {
		try {
			this.api.appendEntry(EXTERNAL_AUDIT_TYPE, { at: Date.now(), ...data });
		} catch {
			// The session ended: nothing to record in.
		}
	}

	/** `message.send` (`bridge/send.ts`), with this API's session, receipts and audit. */
	private send(params: Record<string, unknown>, connection: Connection): Promise<unknown> {
		return sendMessage(
			{
				api: this.api,
				agents: this.agents,
				operations: this.operations,
				receipts: this.receipts,
				log: this.log,
				session: () => this.session(),
				guardSession: (given, ctx) => this.guardSession(given, ctx),
				nextId: () => `x${++this.counter}`,
				audit: (data) => this.audit(data),
				transport: connection.transport,
				verify: (facts, timeoutMs) => this.verify(facts, params, connection, timeoutMs),
			},
			params,
		);
	}

	/** One page of the transcript's user and assistant text (`historyPage`). */
	private history(limit: number, before?: number): unknown {
		return historyPage(this.session(), this.lastAssistantText, limit, before);
	}
}
