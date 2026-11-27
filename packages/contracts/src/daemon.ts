import { TerminalCommandRequestSchema } from "./terminal-command.ts";
import { Type, type Static } from "typebox";
import { ApplicationCommandSchema, ApplicationCursorSchema } from "./application.ts";
import { WorkspaceCommandSchema } from "./protocol.ts";
import { TOOL_DECIDED_BY, ToolAuditSchema, ToolExposureStateSchema } from "./tool-exposure.ts";
import { StringEnum } from "./schema.ts";

/** Version of the daemon's own HTTP surface and record; a launcher and daemon of different versions do not talk. */
export const DAEMON_PROTOCOL_VERSION = 1 as const;
/** Version of the session attach protocol; a session and daemon of different versions refuse each other at hello. */
export const ATTACH_PROTOCOL_VERSION = 1 as const;
/** A request line to a session is at most this long; the session API caps its frames the same way. */
export const ATTACH_MAX_REQUEST_BYTES = 1024 * 1024;
/** A response to a request the daemon made is at most this long (history pages and assets are larger than requests). */
export const ATTACH_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** An unsolicited line (an application frame, a workspace change, the end of a session) is at most this long. */
export const ATTACH_MAX_EVENT_BYTES = 1024 * 1024;

const Text = (maxLength = 256) => Type.String({ minLength: 1, maxLength });

/** `<octocode home>/web/daemon.json` (owner-only): how a launcher finds, validates and signs in to the running daemon. */
export const DaemonRecordSchema = Type.Object(
	{
		pid: Type.Integer({ minimum: 1 }),
		pid_started: Type.Optional(Text(64)),
		port: Type.Integer({ minimum: 1, maximum: 65535 }),
		/** Loopback origin with the launch capability in the fragment (`http://127.0.0.1:<port>/#access=<token>`). */
		url: Text(512),
		protocolVersion: Type.Literal(DAEMON_PROTOCOL_VERSION),
		/** Package version plus a hash of the served page: a launcher of another build drains this daemon. */
		build: Text(128),
		startedAt: Type.Number(),
		/** Random per start; the authenticated health answer repeats it, so a record is never trusted on a pid alone. */
		nonce: Text(128),
	},
	{ additionalProperties: false },
);

/** `GET /api/health` without a token: nothing but compatibility. */
export const DaemonHealthSchema = Type.Object(
	{ ok: Type.Literal(true), protocolVersion: Type.Literal(DAEMON_PROTOCOL_VERSION), build: Text(128) },
	{ additionalProperties: false },
);

/** `GET /api/health` with the bearer token: the run's identity and load. */
export const DaemonStatusSchema = Type.Object(
	{
		ok: Type.Literal(true),
		protocolVersion: Type.Literal(DAEMON_PROTOCOL_VERSION),
		build: Text(128),
		nonce: Text(128),
		pid: Type.Integer({ minimum: 1 }),
		startedAt: Type.Number(),
		tabs: Type.Integer({ minimum: 0 }),
		sessions: Type.Integer({ minimum: 0 }),
		draining: Type.Boolean(),
		/** Minutes with no tab, attached session or relay device after which it exits; absent from an older daemon. */
		idleMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	},
	{ additionalProperties: false },
);

export { DaemonAccessSchema, type DaemonAccess } from "./daemon-access.ts";

/** `<octocode home>/web/attach/<sessionId>.json` (owner-only): where a live session accepts the daemon, and its capability. */
export const AttachRecordSchema = Type.Object(
	{
		protocolVersion: Type.Literal(ATTACH_PROTOCOL_VERSION),
		sessionId: Text(),
		pid: Type.Integer({ minimum: 1 }),
		pid_started: Type.Optional(Text(64)),
		port: Type.Integer({ minimum: 1, maximum: 65535 }),
		/** 32 random bytes in hex: the only credential the session accepts. */
		token: Text(128),
		cwd: Type.String({ maxLength: 4096 }),
		repo: Type.Object(
			{ key: Text(4096), name: Type.String({ maxLength: 256 }), root: Text(4096) },
			{ additionalProperties: false },
		),
		startedAt: Type.Number(),
	},
	{ additionalProperties: false },
);

const requestId = { id: Type.String({ minLength: 1, maxLength: 64 }) };
const streamId = Type.String({ minLength: 1, maxLength: 64 });

/** One newline-delimited JSON request from the daemon to a session. `attach.hello` must come first. */
export const AttachRequestSchema = Type.Union([
	Type.Object({
		...requestId,
		method: Type.Literal("attach.hello"),
		params: Type.Object(
			{ token: Text(128), protocolVersion: Type.Literal(ATTACH_PROTOCOL_VERSION) },
			{ additionalProperties: false },
		),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("application.connect"),
		params: Type.Object({ streamId, cursor: Type.Optional(ApplicationCursorSchema) }, { additionalProperties: false }),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("application.disconnect"),
		params: Type.Object({ streamId }, { additionalProperties: false }),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("application.execute"),
		params: Type.Object({ command: ApplicationCommandSchema }, { additionalProperties: false }),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("application.readAsset"),
		params: Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("application.history"),
		params: Type.Object(
			{
				before: Type.Optional(Text(512)),
				activityBefore: Type.Optional(Text(512)),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			},
			{ additionalProperties: false },
		),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("application.evidence"),
		params: Type.Object({ anchor: Text(1200), cursor: Type.Optional(Text(64)) }, { additionalProperties: false }),
	}),
	Type.Object({ ...requestId, method: Type.Literal("workspace.snapshot") }),
	Type.Object({ ...requestId, method: Type.Literal("workspace.revision") }),
	Type.Object({ ...requestId, method: Type.Literal("workspace.subscribe") }),
	Type.Object({ ...requestId, method: Type.Literal("profiler.agents") }),
	Type.Object({
		...requestId,
		method: Type.Literal("profiler.requests"),
		params: Type.Object(
			{
				agentId: Text(64),
				after: Type.Optional(Type.Integer({ minimum: 0 })),
				detail: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
	}),
	Type.Object({ ...requestId, method: Type.Literal("profiler.subscribe") }),
	Type.Object({ ...requestId, method: Type.Literal("profiler.unsubscribe") }),
	Type.Object({ ...requestId, method: Type.Literal("profiler.insights") }),
	Type.Object({ ...requestId, method: Type.Literal("profiler.trace") }),
	Type.Object({
		...requestId,
		method: Type.Literal("profiler.messages"),
		params: Type.Object(
			{
				limit: Type.Integer({ minimum: 1, maximum: 500 }),
				before: Type.Optional(
					Type.Object({ at: Type.Integer({ minimum: 0 }), key: Text(32) }, { additionalProperties: false }),
				),
			},
			{ additionalProperties: false },
		),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("profiler.transcript"),
		params: Type.Object(
			{ agentId: Text(64), entry: Type.Integer({ minimum: 0 }), sessionId: Type.Optional(Text(128)) },
			{ additionalProperties: false },
		),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("profiler.timeline"),
		params: Type.Object({ since: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
	}),
	Type.Object({
		...requestId,
		method: Type.Literal("workspace.execute"),
		params: Type.Object({ command: WorkspaceCommandSchema }, { additionalProperties: false }),
	}),
	/** What the running session declares of each tool (`AttachToolStates`), for the Settings → Tools panel of its page. */
	Type.Object({ ...requestId, method: Type.Literal("session.tools") }),
	Type.Object({ ...requestId, method: Type.Literal("session.commands"), params: TerminalCommandRequestSchema }),
	/** The daemon changed this session's board: the session repaints what it shows of it (the terminal footer counts). */
	Type.Object({ ...requestId, method: Type.Literal("backlog.changed") }),
]);

/** A request's answer: the same `id`, then a result or an error. */
export const AttachResponseSchema = Type.Union([
	Type.Object({ id: Type.String(), ok: Type.Literal(true), result: Type.Optional(Type.Unknown()) }),
	Type.Object({
		id: Type.String(),
		ok: Type.Literal(false),
		error: Type.Object({ code: Text(64), message: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
	}),
]);

export const AttachHelloResultSchema = Type.Object(
	{
		sessionId: Text(),
		protocolVersion: Type.Literal(ATTACH_PROTOCOL_VERSION),
		capabilities: Type.Array(Text(64), { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

/** A tool or server name as a session reports it; the Tools panel leaves out a name it cannot show. */
const ToolName = Type.String({ minLength: 1, maxLength: 256 });

/**
 * The answer to `session.tools`: what the running session declares of each tool. `native.names` lists every registered
 * native tool and `native.deferred` how each deferrable one was declared (true: deferred); `mcp` is each MCP server's
 * tool states, absent when the session has no MCP host. A session advertises the request with the `tools` capability.
 */
export const AttachToolStatesSchema = Type.Object(
	{
		native: Type.Object(
			{
				names: Type.Array(ToolName, { maxItems: 500 }),
				deferred: Type.Record(Type.String({ maxLength: 256 }), Type.Boolean()),
				/** Bytes each deferrable tool's deferral saves per request (full minus thin declaration). */
				saved: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), Type.Integer({ minimum: 0 }))),
			},
			{ additionalProperties: false },
		),
		/** Complete live registry names, including disabled entries. Absent on older or unavailable hosts. */
		mcpServerNames: Type.Optional(Type.Array(ToolName, { maxItems: 500 })),
		mcp: Type.Optional(
			Type.Array(
				Type.Object(
					{
						server: ToolName,
						connected: Type.Boolean(),
						saved: Type.Boolean(),
						tools: Type.Array(
							Type.Object(
								{
									name: ToolName,
									state: ToolExposureStateSchema,
									decidedBy: StringEnum(TOOL_DECIDED_BY),
									audit: Type.Optional(ToolAuditSchema),
								},
								{ additionalProperties: false },
							),
							{ maxItems: 2000 },
						),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 500 },
			),
		),
	},
	{ additionalProperties: false },
);

/** Unrequested lines from a session: a frame of a stream the daemon opened, a changed workspace, or the end of the session. */
export const AttachEventSchema = Type.Union([
	Type.Object({ event: Type.Literal("application.frame"), streamId, frame: Type.Unknown() }),
	Type.Object({ event: Type.Literal("application.end"), streamId }),
	Type.Object({ event: Type.Literal("workspace.changed") }),
	Type.Object({ event: Type.Literal("profiler.update"), data: Type.Unknown() }),
	Type.Object({ event: Type.Literal("session.closed") }),
]);

export * from "./daemon-lists.ts";
export * from "./daemon-remote.ts";

export type DaemonRecord = Static<typeof DaemonRecordSchema>;
export type DaemonHealth = Static<typeof DaemonHealthSchema>;
export type DaemonStatus = Static<typeof DaemonStatusSchema>;
export type AttachRecord = Static<typeof AttachRecordSchema>;
export type AttachRequest = Static<typeof AttachRequestSchema>;
export type AttachResponse = Static<typeof AttachResponseSchema>;
export type AttachHelloResult = Static<typeof AttachHelloResultSchema>;
export type AttachToolStates = Static<typeof AttachToolStatesSchema>;
export type AttachEvent = Static<typeof AttachEventSchema>;
