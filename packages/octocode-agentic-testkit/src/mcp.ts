import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi, type Mock } from "vitest";
import { checkGuards, serverCalls, type Guard } from "./guards.ts";
import { httpMcpClient, type ClientIdentity, type McpClient } from "./mcp-client.ts";
import { contentServer, type PromptDef, type PromptMock, type ResourceDef, type ResourceMock } from "./mcp-content.ts";
import { header, parseMessage, readBody, RPC_ERROR, rpcError, RpcFailure, send, type Rpc } from "./mcp-rpc.ts";
import { schemaError, type ObjectSchema } from "./mcp-schema.ts";
import { mcpToolName, Trace } from "./trace.ts";

export { connectMcp, type ClientIdentity, type McpCallResult, type McpClient, type McpToolInfo } from "./mcp-client.ts";
export type { PromptArgument, PromptDef, PromptMessage, PromptMock, ResourceDef, ResourceMock } from "./mcp-content.ts";
export type { JsonSchema, ObjectSchema } from "./mcp-schema.ts";

export interface ToolDef {
	name: string;
	description: string;
	/** Checked recursively before the handler runs; a violation is an `invalid-args` error result. */
	inputSchema: ObjectSchema;
	/**
	 * Advertised in `tools/list`. When the handler returns an object, it is checked against this schema and sent as
	 * `structuredContent` beside its JSON text; a violation is an `invalid-output` error result.
	 */
	outputSchema?: ObjectSchema;
	/** May be async; a rejection behaves like a throw. */
	handler?: (args: Record<string, unknown>) => unknown;
}

export type FailKind = "timeout" | "error";

export type ToolMock = Mock<(args: Record<string, unknown>) => unknown> & {
	/** Fixed value the tool returns from now on. */
	returns(value: unknown): ToolMock;
	/** The next call fails once: `error` returns an MCP error result, `timeout` never answers (held until the client aborts or the mock closes). */
	failOnce(kind: FailKind): ToolMock;
};

/** A session the mock issued on `initialize` (the `Mcp-Session-Id` header). */
export interface McpSession {
	id: string;
	/** Requests after `initialize` that carried this id. */
	requests: number;
	/** Ended by the client's DELETE; a later request with this id gets 404. */
	closed: boolean;
}

export interface MockMcp {
	name: string;
	trace: Trace;
	/** The tools as the server advertises them in `tools/list`. */
	defs: readonly ToolDef[];
	tool(name: string): ToolMock;
	/** Spy on `resources/read` of one configured resource. */
	resource(uri: string): ResourceMock;
	/** Spy on `prompts/get` of one configured prompt. */
	prompt(name: string): PromptMock;
	/** Sessions issued so far, oldest first. */
	sessions(): McpSession[];
	listen(): Promise<string>;
	client(identity?: ClientIdentity): McpClient;
	/** Calls currently held open by `failOnce("timeout")`. */
	stalledCalls(): number;
	close(): Promise<void>;
}

interface Control {
	fixed?: { value: unknown };
	fail: FailKind[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

/**
 * A minimal MCP server (Streamable HTTP, JSON responses, sessions) whose tools, resources and prompts are `vi.fn`
 * spies. `resources` and `prompts` are advertised as capabilities only when given.
 */
export interface MockMcpOptions {
	name: string;
	tools: ToolDef[];
	resources?: ResourceDef[];
	prompts?: PromptDef[];
	trace?: Trace;
	/** Judged before each `tools/call`; a block answers with an error result and records a `guard` event. */
	guards?: readonly Guard[];
}

export function mockMcp(opts: MockMcpOptions): MockMcp {
	const trace = opts.trace ?? new Trace();
	trace.observe(`mcp:${opts.name}`);
	if (opts.guards?.length) trace.observe("guards");
	const defs = new Map(opts.tools.map((t) => [t.name, t]));
	const content = contentServer(opts.name, opts.resources, opts.prompts);
	const controls = new Map<string, Control>();
	const mocks = new Map<string, ToolMock>();
	for (const def of opts.tools) {
		const ctl: Control = { fail: [] };
		controls.set(def.name, ctl);
		const fn = vi.fn((args: Record<string, unknown>): unknown => {
			const kind = ctl.fail.shift();
			if (kind) throw Object.assign(new Error(`injected ${kind}`), { kind });
			if (ctl.fixed) return ctl.fixed.value;
			return def.handler ? def.handler(args) : `${def.name}: ok`;
		}) as unknown as ToolMock;
		fn.returns = (value) => {
			ctl.fixed = { value };
			return fn;
		};
		fn.failOnce = (kind) => {
			ctl.fail.push(kind);
			return fn;
		};
		mocks.set(def.name, fn);
	}

	const sessions = new Map<string, McpSession>();
	const stalled = new Set<ServerResponse>();
	/** Hold the response open: the caller sees a hang, not a dropped connection. Released when it disconnects. */
	const stall = (res: ServerResponse): void => {
		stalled.add(res);
		res.on("close", () => stalled.delete(res));
	};

	const call = async (req: IncomingMessage, res: ServerResponse, rpc: Rpc): Promise<void> => {
		const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
		// Identity: explicit headers win; otherwise the agent whose model asked for this tool most recently.
		const asked = trace.events.findLast((e) => e.kind === "model_tool_call" && e.name === mcpToolName(opts.name, name));
		const agent = header(req, "x-testkit-agent") ?? asked?.agent ?? "main";
		const span = header(req, "x-testkit-span") ?? (header(req, "x-testkit-agent") ? agent : (asked?.span ?? agent));
		const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
		const def = defs.get(name);
		const result = (t: string, isError: boolean, structured?: Record<string, unknown>): void =>
			send(res, {
				jsonrpc: "2.0",
				id: rpc.id,
				result: {
					content: [{ type: "text", text: t }],
					...(structured ? { structuredContent: structured } : {}),
					isError,
				},
			});
		const base = { agent, span, name, args, server: opts.name } as const;
		const blocked = checkGuards(opts.guards, { name, args, agent, server: opts.name }, serverCalls(trace, opts.name));
		if (blocked) {
			trace.cut = true;
			trace.record({ kind: "guard", ...base, data: { reason: blocked, by: `mcp:${opts.name}` } });
			return result(`blocked: ${blocked}`, true);
		}
		if (!def) {
			trace.record({ kind: "tool_error", ...base, data: "unknown-tool" });
			return result(`unknown tool ${name}`, true);
		}
		const bad = schemaError(def.inputSchema, args);
		if (bad) {
			trace.record({ kind: "tool_error", ...base, data: { reason: "invalid-args", message: bad } });
			return result(`invalid arguments: ${bad}`, true);
		}
		let value: unknown;
		try {
			value = await Promise.resolve(mocks.get(name)!(args));
		} catch (e) {
			const kind = (e as { kind?: string }).kind ?? "error";
			const message = e instanceof Error ? e.message : String(e);
			trace.record({ kind: "tool_error", ...base, data: { reason: kind, message } });
			if (kind === "timeout") stall(res);
			else result(message, true);
			return;
		}
		const structured = def.outputSchema && isObject(value) ? value : undefined;
		const badOutput = structured && schemaError(def.outputSchema, structured);
		if (badOutput) {
			trace.record({ kind: "tool_error", ...base, data: { reason: "invalid-output", message: badOutput } });
			return result(`invalid output: ${badOutput}`, true);
		}
		trace.record({ kind: "tool_exec", ...base, data: value });
		result(text(value), false, structured);
	};

	const answer = async (rpc: Rpc): Promise<unknown> => {
		if (rpc.method === "initialize")
			return {
				protocolVersion: typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-06-18",
				capabilities: { tools: {}, ...content.capabilities },
				serverInfo: { name: opts.name, version: "0.0.0" },
			};
		if (rpc.method === "ping") return {};
		if (rpc.method === "tools/list")
			return {
				tools: opts.tools.map(({ name, description, inputSchema, outputSchema }) => ({
					name,
					description,
					inputSchema,
					...(outputSchema ? { outputSchema } : {}),
				})),
			};
		const handled = content.handle(rpc);
		if (handled) return handled;
		throw new RpcFailure(RPC_ERROR.noMethod, `no method ${rpc.method}`);
	};

	const dispatch = async (req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> => {
		const msg = parseMessage(raw);
		if (msg.kind === "invalid") return send(res, rpcError(null, msg.code, msg.message), 400);
		if (msg.kind === "accepted") return void res.writeHead(202).end();
		const { rpc } = msg;
		if (rpc.method === "tools/call") return call(req, res, rpc);
		let result: unknown;
		try {
			result = await answer(rpc);
		} catch (e) {
			const code = e instanceof RpcFailure ? e.code : RPC_ERROR.internal;
			return send(res, rpcError(rpc.id, code, e instanceof Error ? e.message : String(e)));
		}
		if (rpc.method !== "initialize") return send(res, { jsonrpc: "2.0", id: rpc.id, result });
		const id = randomUUID();
		sessions.set(id, { id, requests: 0, closed: false });
		send(res, { jsonrpc: "2.0", id: rpc.id, result }, 200, { "mcp-session-id": id });
	};

	const server = createServer((req, res) => {
		// A session id the mock never issued, or one the client ended, gets 404 (MCP Streamable HTTP); no id is accepted.
		const sid = header(req, "mcp-session-id");
		const session = sid === undefined ? undefined : sessions.get(sid);
		if (sid !== undefined && (!session || session.closed))
			return send(res, rpcError(null, RPC_ERROR.sessionNotFound, `session ${sid} not found`), 404);
		if (req.method === "DELETE") {
			if (session) session.closed = true;
			return void res.writeHead(200).end();
		}
		if (req.method !== "POST") return void res.writeHead(405).end();
		if (session) session.requests++;
		readBody(req)
			.then((raw) => dispatch(req, res, raw))
			.catch((e: unknown): void => {
				// A bug in the mock or a guard: answer it with its message, never an empty 400.
				if (res.headersSent) return void res.destroy();
				send(res, rpcError(null, RPC_ERROR.internal, e instanceof Error ? e.message : String(e)), 500);
			});
	});

	let url: string | undefined;
	const listen = async (): Promise<string> => {
		if (url) return url;
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
		return url;
	};

	return {
		name: opts.name,
		trace,
		defs: opts.tools,
		tool(name) {
			const m = mocks.get(name);
			if (!m) throw new Error(`mockMcp ${opts.name}: no tool ${name}`);
			return m;
		},
		resource: (uri) => content.resource(uri),
		prompt: (name) => content.prompt(name),
		sessions: () => Array.from(sessions.values(), (s) => ({ ...s })),
		listen,
		stalledCalls: () => stalled.size,
		client: (identity = {}) => httpMcpClient(opts.name, listen, identity),
		close: () =>
			new Promise<void>((resolve) => {
				if (!url) return resolve();
				for (const r of stalled) r.destroy();
				stalled.clear();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
