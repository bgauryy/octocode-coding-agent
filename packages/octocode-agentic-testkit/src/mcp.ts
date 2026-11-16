import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi, type Mock } from "vitest";
import { Trace } from "./trace.ts";

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties?: Record<string, { type?: string }>; required?: string[] };
	handler?: (args: Record<string, unknown>) => unknown;
}

export type FailKind = "timeout" | "error";

export type ToolMock = Mock<(args: Record<string, unknown>) => unknown> & {
	/** Fixed value the tool returns from now on. */
	returns(value: unknown): ToolMock;
	/** The next call fails once: `error` returns an MCP error result, `timeout` never answers (held until the client aborts or the mock closes). */
	failOnce(kind: FailKind): ToolMock;
};

export interface McpToolInfo {
	name: string;
	description: string;
	inputSchema: ToolDef["inputSchema"];
}

export interface McpCallResult {
	isError: boolean;
	text: string;
}

export interface McpClient {
	server: string;
	listTools(): Promise<McpToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

export interface ClientIdentity {
	agent?: string;
	span?: string;
	/** Abort a request that gets no answer after this long (default 30000). */
	timeoutMs?: number;
}

export interface MockMcp {
	name: string;
	trace: Trace;
	tool(name: string): ToolMock;
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

type Rpc = { id?: number | string | null; method: string; params?: Record<string, unknown> };

function validate(def: ToolDef, args: Record<string, unknown>): string | undefined {
	for (const key of def.inputSchema.required ?? []) if (!(key in args)) return `missing required argument "${key}"`;
	for (const [key, spec] of Object.entries(def.inputSchema.properties ?? {})) {
		const v = args[key];
		if (v === undefined || !spec.type) continue;
		const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
		const ok = spec.type === "integer" ? Number.isInteger(v) : actual === spec.type;
		if (!ok) return `argument "${key}" must be ${spec.type}, got ${actual}`;
	}
	return undefined;
}

function text(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, body: unknown): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** The sanitized namespace the agent prefixes tools with: `mcp__<server>__<tool>`. */
const namespaced = (server: string, tool: string): string => `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__${tool}`;

const hdr = (req: IncomingMessage, k: string): string | undefined => {
	const v = req.headers[k];
	return Array.isArray(v) ? v[0] : v;
};

/** A minimal MCP server (Streamable HTTP, JSON responses) whose tools are `vi.fn` spies. */
export function mockMcp(opts: { name: string; tools: ToolDef[]; trace?: Trace }): MockMcp {
	const trace = opts.trace ?? new Trace();
	const defs = new Map(opts.tools.map((t) => [t.name, t]));
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

	const stalled = new Set<ServerResponse>();
	/** Hold the response open: the caller sees a hang, not a dropped connection. Released when it disconnects. */
	const stall = (res: ServerResponse): void => {
		stalled.add(res);
		res.on("close", () => stalled.delete(res));
	};

	const call = (req: IncomingMessage, res: ServerResponse, rpc: Rpc): void => {
		const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
		// Identity: explicit headers win; otherwise the agent whose model asked for this tool most recently.
		const asked = trace.events.findLast((e) => e.kind === "model_tool_call" && e.name === namespaced(opts.name, name));
		const agent = hdr(req, "x-testkit-agent") ?? asked?.agent ?? "main";
		const span = hdr(req, "x-testkit-span") ?? (hdr(req, "x-testkit-agent") ? agent : (asked?.span ?? agent));
		const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
		const def = defs.get(name);
		const result = (t: string, isError: boolean): void =>
			send(res, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: t }], isError } });
		const base = { agent, span, name, args, server: opts.name } as const;
		if (!def) {
			trace.record({ kind: "tool_error", ...base, data: "unknown-tool" });
			return result(`unknown tool ${name}`, true);
		}
		const bad = validate(def, args);
		if (bad) {
			trace.record({ kind: "tool_error", ...base, data: { reason: "invalid-args", message: bad } });
			return result(`invalid arguments: ${bad}`, true);
		}
		try {
			const value = mocks.get(name)!(args);
			trace.record({ kind: "tool_exec", ...base, data: value });
			result(text(value), false);
		} catch (e) {
			const kind = (e as { kind?: string }).kind ?? "error";
			const message = e instanceof Error ? e.message : String(e);
			trace.record({ kind: "tool_error", ...base, data: { reason: kind, message } });
			if (kind === "timeout") stall(res);
			else result(message, true);
		}
	};

	const server = createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(req.method === "DELETE" ? 200 : 405).end();
			return;
		}
		readBody(req)
			.then((raw) => {
				const rpc = JSON.parse(raw) as Rpc;
				if (rpc.id === undefined) return void res.writeHead(202).end();
				if (rpc.method === "initialize")
					return send(res, {
						jsonrpc: "2.0",
						id: rpc.id,
						result: {
							protocolVersion:
								typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: opts.name, version: "0.0.0" },
						},
					});
				if (rpc.method === "ping") return send(res, { jsonrpc: "2.0", id: rpc.id, result: {} });
				if (rpc.method === "tools/list")
					return send(res, {
						jsonrpc: "2.0",
						id: rpc.id,
						result: {
							tools: opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
						},
					});
				if (rpc.method === "tools/call") return call(req, res, rpc);
				send(res, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `no method ${rpc.method}` } });
			})
			.catch(() => void res.writeHead(400).end());
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
		tool(name) {
			const m = mocks.get(name);
			if (!m) throw new Error(`mockMcp ${opts.name}: no tool ${name}`);
			return m;
		},
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

/** Minimal JSON-RPC client: initialize, notifications/initialized, tools/list, tools/call. */
function httpMcpClient(server: string, listen: () => Promise<string>, identity: ClientIdentity): McpClient {
	let id = 0;
	let ready: Promise<void> | undefined;
	const post = async (body: unknown): Promise<{ result?: unknown; error?: { message: string } }> => {
		const r = await fetch(await listen(), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"x-testkit-agent": identity.agent ?? "main",
				"x-testkit-span": identity.span ?? identity.agent ?? "main",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(identity.timeoutMs ?? 30_000),
		});
		const raw = await r.text();
		return raw ? JSON.parse(raw) : {};
	};
	const rpc = async (method: string, params?: unknown): Promise<unknown> => {
		ready ??= post({
			jsonrpc: "2.0",
			id: ++id,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "testkit", version: "0" } },
		}).then(async () => {
			await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		});
		await ready;
		const out = await post({ jsonrpc: "2.0", id: ++id, method, params });
		if (out.error) throw new Error(out.error.message);
		return out.result;
	};
	return {
		server,
		async listTools() {
			return ((await rpc("tools/list")) as { tools: McpToolInfo[] }).tools;
		},
		async callTool(name, args) {
			const r = (await rpc("tools/call", { name, arguments: args })) as {
				content?: { text?: string }[];
				isError?: boolean;
			};
			return { isError: r.isError === true, text: (r.content ?? []).map((c) => c.text ?? "").join("\n") };
		},
	};
}
