import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkGuards, serverCalls, type Guard } from "./guards.ts";
import { connectMcp, type ClientIdentity, type McpClient, type McpToolInfo } from "./mcp-client.ts";
import { header, parseMessage, readBody, RPC_ERROR, rpcError, send, type Rpc } from "./mcp-rpc.ts";
import { openUpstream, type McpTarget, type Upstream } from "./mcp-upstream.ts";
import { mcpToolName, type Trace } from "./trace.ts";

export type { McpTarget } from "./mcp-upstream.ts";

export interface RecordMcpOptions {
	/** The server's name as agents see it: its tools are `mcp__<name>__<tool>`. */
	name: string;
	trace: Trace;
	/** The real server: `{ command, args, env, cwd }` (stdio) or `{ url, headers }` (Streamable HTTP). */
	target: McpTarget;
	/** Judged before a call reaches the real server; a block answers an error result. */
	guards?: readonly Guard[];
	/** Per request to the real server (default 60000). */
	timeoutMs?: number;
	/**
	 * Test-only: the tools as agents see them, such as one description rewritten for an A/B run. The real server is
	 * unchanged and still validates every call.
	 */
	transformTools?: (tools: McpToolInfo[]) => McpToolInfo[];
}

/** One `tools/call` that reached the real server (or a guard stopped). */
export interface McpCallRecord {
	tool: string;
	args: Record<string, unknown>;
	agent: string;
	/** The server answered an error result or a JSON-RPC error, or the call never got an answer. */
	isError: boolean;
	blocked?: string;
	/** Characters of the result's text content: what the agent's model will read. */
	chars: number;
	/** `chars / 4`, the kit's usual estimate. */
	estTokens: number;
	/** Characters of the arguments as JSON. */
	argChars: number;
	durationMs: number;
	error?: string;
}

/** Totals over `calls()`, overall and per tool. */
export interface McpCallSummary {
	calls: number;
	errors: number;
	resultChars: number;
	estTokens: number;
	maxChars: number;
	maxDurationMs: number;
	byTool: Record<
		string,
		{ calls: number; errors: number; resultChars: number; maxChars: number; maxDurationMs: number }
	>;
}

/** A real MCP server behind a recording HTTP endpoint that any adapter registers like a mock. */
export interface RecordedMcp {
	name: string;
	trace: Trace;
	/** Starts the server, runs `initialize` and reads `tools/list`; `listen` and `client` call it for you. */
	ready(): Promise<void>;
	/** The tools as agents see them (after `transformTools`), once `ready` resolved; `analyzeSurface({ servers: [rec] })`. */
	readonly defs: McpToolInfo[];
	/** The server's `initialize` instructions, once `ready` resolved. */
	readonly instructions: string | undefined;
	/** The HTTP MCP endpoint for `AdapterContext.mcpUrls`. */
	listen(): Promise<string>;
	/** A direct client, for contract tests without a model; its calls are recorded too. */
	client(identity?: ClientIdentity): McpClient;
	calls(): McpCallRecord[];
	summary(): McpCallSummary;
	close(): Promise<void>;
}

const textOf = (result: unknown): string => {
	const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? [];
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
};

/**
 * Records every call an agent makes to a real MCP server: arguments, result size, latency and errors land on the
 * trace as `tool_exec` / `tool_error` (probe `mcp:<name>`), so `toHaveCalledMcp` and the other matchers work on the
 * real server, and `calls()` / `summary()` measure it.
 */
export function recordMcp(opts: RecordMcpOptions): RecordedMcp {
	const { trace, name } = opts;
	trace.observe(`mcp:${name}`);
	const records: McpCallRecord[] = [];
	let started: Promise<void> | undefined;
	let upstream: Upstream | undefined;
	let init: Record<string, unknown> = {};
	let defs: McpToolInfo[] = [];

	const ready = (): Promise<void> =>
		(started ??= (async () => {
			const opened = await openUpstream(opts.target, opts.timeoutMs ?? 60_000);
			upstream = opened.upstream;
			init = opened.init;
			const listed = await upstream.request("tools/list");
			if (listed.error) throw new Error(`MCP server ${name}: tools/list failed: ${listed.error.message}`);
			const tools = (listed.result as { tools?: McpToolInfo[] } | undefined)?.tools ?? [];
			defs = opts.transformTools ? opts.transformTools(tools) : tools;
		})());

	const call = async (req: IncomingMessage, res: ServerResponse, rpc: Rpc): Promise<void> => {
		const tool = typeof rpc.params?.name === "string" ? rpc.params.name : "";
		const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
		const asked = trace.events.findLast((e) => e.kind === "model_tool_call" && e.name === mcpToolName(name, tool));
		const agent = header(req, "x-testkit-agent") ?? asked?.agent ?? "main";
		const span = header(req, "x-testkit-span") ?? asked?.span ?? agent;
		const base = { agent, span, name: tool, args, server: name } as const;
		const argChars = JSON.stringify(args).length;
		const blocked = checkGuards(opts.guards, { name: tool, args, agent, server: name }, serverCalls(trace, name));
		if (blocked) {
			trace.cut = true;
			trace.record({ kind: "guard", ...base, data: { reason: blocked, by: `mcp:${name}` } });
			records.push({ tool, args, agent, isError: true, blocked, chars: 0, estTokens: 0, argChars, durationMs: 0 });
			return send(res, {
				jsonrpc: "2.0",
				id: rpc.id,
				result: { content: [{ type: "text", text: `blocked: ${blocked}` }], isError: true },
			});
		}
		const t0 = performance.now();
		let answer: Awaited<ReturnType<Upstream["request"]>>;
		try {
			answer = await upstream!.request("tools/call", rpc.params);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			const durationMs = performance.now() - t0;
			trace.record({ kind: "tool_error", ...base, data: { reason: "upstream", message, durationMs } });
			records.push({ tool, args, agent, isError: true, chars: 0, estTokens: 0, argChars, durationMs, error: message });
			return send(res, rpcError(rpc.id, RPC_ERROR.internal, message));
		}
		const durationMs = performance.now() - t0;
		const text = answer.error ? answer.error.message : textOf(answer.result);
		const isError =
			answer.error !== undefined || (answer.result as { isError?: unknown } | undefined)?.isError === true;
		const chars = text.length;
		records.push({
			tool,
			args,
			agent,
			isError,
			chars,
			estTokens: Math.ceil(chars / 4),
			argChars,
			durationMs,
			...(isError ? { error: text } : {}),
		});
		trace.record(
			isError
				? {
						kind: "tool_error",
						...base,
						data: { reason: answer.error ? "rpc-error" : "error-result", message: text, durationMs },
					}
				: { kind: "tool_exec", ...base, data: { text, chars, durationMs } },
		);
		send(res, { jsonrpc: "2.0", id: rpc.id, ...(answer.error ? { error: answer.error } : { result: answer.result }) });
	};

	const dispatch = async (req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> => {
		const msg = parseMessage(raw);
		if (msg.kind === "invalid") return send(res, rpcError(null, msg.code, msg.message), 400);
		// The kit owns the real server's session: a client's own `initialized` and notifications stop here.
		if (msg.kind === "accepted") return void res.writeHead(202).end();
		const { rpc } = msg;
		await ready();
		if (rpc.method === "initialize") return send(res, { jsonrpc: "2.0", id: rpc.id, result: init });
		if (rpc.method === "tools/list") return send(res, { jsonrpc: "2.0", id: rpc.id, result: { tools: defs } });
		if (rpc.method === "tools/call") return call(req, res, rpc);
		const answer = await upstream!.request(rpc.method, rpc.params);
		send(res, { jsonrpc: "2.0", id: rpc.id, ...(answer.error ? { error: answer.error } : { result: answer.result }) });
	};

	const server = createServer((req, res): void => {
		if (req.method === "DELETE") return void res.writeHead(200).end();
		if (req.method !== "POST") return void res.writeHead(405).end();
		readBody(req)
			.then((raw) => dispatch(req, res, raw))
			.catch((e: unknown): void => {
				if (res.headersSent) return void res.destroy();
				send(res, rpcError(null, RPC_ERROR.internal, e instanceof Error ? e.message : String(e)), 500);
			});
	});

	let url: string | undefined;
	const listen = async (): Promise<string> => {
		await ready();
		if (url) return url;
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
		return url;
	};

	return {
		name,
		trace,
		ready,
		get defs() {
			return defs;
		},
		get instructions() {
			return typeof init.instructions === "string" ? init.instructions : undefined;
		},
		listen,
		client: (identity = {}) => ({
			server: name,
			listTools: async () => connectMcp(name, await listen(), identity).listTools(),
			callTool: async (tool, args) => connectMcp(name, await listen(), identity).callTool(tool, args),
		}),
		calls: () => records.map((r) => ({ ...r, args: { ...r.args } })),
		summary: () => summarize(records),
		close: async () => {
			if (url) {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			// A server that failed to start already rejected `ready`; there is nothing of it left to close.
			if (started) await started.catch(() => undefined);
			await upstream?.close();
		},
	};
}

function summarize(records: McpCallRecord[]): McpCallSummary {
	const byTool: McpCallSummary["byTool"] = {};
	for (const r of records) {
		byTool[r.tool] ??= { calls: 0, errors: 0, resultChars: 0, maxChars: 0, maxDurationMs: 0 };
		const t = byTool[r.tool];
		t.calls++;
		if (r.isError) t.errors++;
		t.resultChars += r.chars;
		t.maxChars = Math.max(t.maxChars, r.chars);
		t.maxDurationMs = Math.max(t.maxDurationMs, r.durationMs);
	}
	const resultChars = records.reduce((n, r) => n + r.chars, 0);
	return {
		calls: records.length,
		errors: records.filter((r) => r.isError).length,
		resultChars,
		estTokens: Math.ceil(resultChars / 4),
		maxChars: Math.max(0, ...records.map((r) => r.chars)),
		maxDurationMs: Math.max(0, ...records.map((r) => r.durationMs)),
		byTool,
	};
}
