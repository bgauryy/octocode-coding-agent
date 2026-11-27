import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RPC_ERROR } from "./mcp-rpc.ts";

/** A real MCP server: a stdio command the kit starts, or a Streamable HTTP endpoint. */
export type McpTarget =
	| { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
	| { url: string; headers?: Record<string, string> };

/** A JSON-RPC response from the real server. */
interface RpcResponse {
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** One connection to a real MCP server, owned by the kit: ids, sessions and server requests are its own. */
export interface Upstream {
	request(method: string, params?: unknown): Promise<RpcResponse>;
	notify(method: string, params?: unknown): Promise<void>;
	close(): Promise<void>;
}

type Message = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown } & RpcResponse;

const PROTOCOL = "2025-06-18";
const tail = (s: string): string => s.slice(-2_000).trim();

/** The kit's answer to a request the server sends its client: `ping`, `roots/list` (the server's cwd), else an error. */
function answerServer(msg: Message, cwd: string): Message {
	if (msg.method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
	if (msg.method === "roots/list")
		return { jsonrpc: "2.0", id: msg.id, result: { roots: [{ uri: pathToFileURL(cwd).href, name: "workspace" }] } };
	return {
		jsonrpc: "2.0",
		id: msg.id,
		error: { code: RPC_ERROR.noMethod, message: `testkit client does not support ${msg.method}` },
	};
}

function stdioUpstream(target: Extract<McpTarget, { command: string }>, timeoutMs: number): Upstream {
	const cwd = target.cwd ?? process.cwd();
	const child: ChildProcess = spawn(target.command, target.args ?? [], {
		cwd,
		env: { ...process.env, ...target.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map<number, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
	let stderr = "";
	let exited: Error | undefined;
	let buffer = "";
	let nextId = 0;
	const write = (msg: Message): void => {
		child.stdin?.write(`${JSON.stringify(msg)}\n`);
	};
	const fail = (e: Error): void => {
		exited = e;
		for (const p of pending.values()) p.reject(e);
		pending.clear();
	};
	child.stderr?.on("data", (c: Buffer) => {
		stderr = (stderr + c.toString("utf8")).slice(-8_000);
	});
	child.on("error", (e) => fail(new Error(`MCP server ${target.command} failed to start: ${e.message}`)));
	child.on("exit", (code, signal) =>
		fail(new Error(`MCP server ${target.command} exited (${signal ?? code})${stderr ? `: ${tail(stderr)}` : ""}`)),
	);
	child.stdout?.on("data", (c: Buffer) => {
		buffer += c.toString("utf8");
		for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			let msg: Message;
			try {
				msg = JSON.parse(line) as Message;
			} catch {
				// A server that logs to stdout breaks the protocol; keep the line visible in errors.
				stderr = (stderr + `\n[stdout] ${line}`).slice(-8_000);
				continue;
			}
			if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) write(answerServer(msg, cwd));
			else if (typeof msg.id === "number" && pending.has(msg.id)) {
				pending.get(msg.id)!.resolve({ result: msg.result, error: msg.error });
				pending.delete(msg.id);
			}
		}
	});
	return {
		request(method, params) {
			if (exited) return Promise.reject(exited);
			const id = ++nextId;
			return new Promise<RpcResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`MCP server ${target.command}: ${method} timed out after ${timeoutMs} ms`));
				}, timeoutMs);
				pending.set(id, {
					resolve: (r) => {
						clearTimeout(timer);
						resolve(r);
					},
					reject: (e) => {
						clearTimeout(timer);
						reject(e);
					},
				});
				write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
			});
		},
		async notify(method, params) {
			if (!exited) write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
		},
		close: () =>
			new Promise<void>((resolve) => {
				if (exited || child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
			}),
	};
}

/** The JSON-RPC message with this id in a Streamable HTTP body: plain JSON or an SSE stream. */
async function responseOf(r: Response, id: number): Promise<Message | undefined> {
	const text = await r.text();
	if (!(r.headers.get("content-type") ?? "").includes("text/event-stream"))
		return text ? (JSON.parse(text) as Message) : undefined;
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trimStart())
			.join("\n");
		if (!data) continue;
		const msg = JSON.parse(data) as Message;
		if (msg.id === id) return msg;
	}
	return undefined;
}

function httpUpstream(target: Extract<McpTarget, { url: string }>, timeoutMs: number): Upstream {
	let session: string | undefined;
	let nextId = 0;
	const post = (msg: Message): Promise<Response> =>
		fetch(target.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": PROTOCOL,
				...target.headers,
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify(msg),
			signal: AbortSignal.timeout(timeoutMs),
		});
	return {
		async request(method, params) {
			const id = ++nextId;
			const r = await post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
			session = r.headers.get("mcp-session-id") ?? session;
			const msg = await responseOf(r, id);
			if (!msg) throw new Error(`MCP server ${target.url}: ${method} got HTTP ${r.status} with no response`);
			return { result: msg.result, error: msg.error };
		},
		async notify(method, params) {
			const r = await post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
			await r.body?.cancel();
		},
		async close() {
			if (!session) return;
			try {
				await fetch(target.url, { method: "DELETE", headers: { "mcp-session-id": session, ...target.headers } });
			} catch (e) {
				// The server is already gone: there is no session left to end.
				if (!(e instanceof TypeError)) throw e;
			}
		},
	};
}

/** Connects to a real MCP server and runs the `initialize` handshake. */
export async function openUpstream(
	target: McpTarget,
	timeoutMs: number,
): Promise<{ upstream: Upstream; init: Record<string, unknown> }> {
	const upstream = "command" in target ? stdioUpstream(target, timeoutMs) : httpUpstream(target, timeoutMs);
	const r = await upstream.request("initialize", {
		protocolVersion: PROTOCOL,
		capabilities: { roots: {} },
		clientInfo: { name: "agentic-testkit", version: "0" },
	});
	if (r.error) {
		await upstream.close();
		throw new Error(`MCP server rejected initialize: ${r.error.message}`);
	}
	await upstream.notify("notifications/initialized");
	return { upstream, init: (r.result ?? {}) as Record<string, unknown> };
}
