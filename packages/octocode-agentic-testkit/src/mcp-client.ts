import type { ObjectSchema } from "./mcp-schema.ts";

export interface McpToolInfo {
	name: string;
	description: string;
	inputSchema: ObjectSchema;
	outputSchema?: ObjectSchema;
}

export interface McpCallResult {
	isError: boolean;
	text: string;
	/** Set when the server sent `structuredContent` (a tool with an `outputSchema`). */
	structuredContent?: Record<string, unknown>;
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

/** A client for an MCP server at `url` that answers with JSON bodies (as `mockMcp` does), sending the identity headers. */
export function connectMcp(server: string, url: string, identity: ClientIdentity = {}): McpClient {
	return httpMcpClient(server, async () => url, identity);
}

interface Answer {
	status: number;
	session?: string;
	body: { result?: unknown; error?: { message: string } };
}

/**
 * Minimal JSON-RPC client: initialize, notifications/initialized, tools/list, tools/call. It sends back the
 * `Mcp-Session-Id` the server issued, and starts a new session once when the server answers 404 for it.
 */
export function httpMcpClient(server: string, listen: () => Promise<string>, identity: ClientIdentity): McpClient {
	let id = 0;
	let ready: Promise<void> | undefined;
	let session: string | undefined;
	const post = async (body: unknown): Promise<Answer> => {
		const span = identity.span ?? identity.agent;
		const r = await fetch(await listen(), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				// Only an explicit identity: without one the server attributes the call to the agent whose model asked.
				...(identity.agent ? { "x-testkit-agent": identity.agent } : {}),
				...(span ? { "x-testkit-span": span } : {}),
				...(session === undefined ? {} : { "mcp-session-id": session }),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(identity.timeoutMs ?? 30_000),
		});
		const raw = await r.text();
		return {
			status: r.status,
			session: r.headers.get("mcp-session-id") ?? undefined,
			body: raw ? JSON.parse(raw) : {},
		};
	};
	const check = (a: Answer, method: string): unknown => {
		if (a.body.error) throw new Error(a.body.error.message);
		if (a.status >= 400) throw new Error(`${server}: ${method} answered HTTP ${a.status}`);
		return a.body.result;
	};
	const open = async (): Promise<void> => {
		const init = await post({
			jsonrpc: "2.0",
			id: ++id,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "testkit", version: "0" } },
		});
		check(init, "initialize");
		session = init.session;
		await post({ jsonrpc: "2.0", method: "notifications/initialized" });
	};
	const rpc = async (method: string, params?: unknown): Promise<unknown> => {
		ready ??= open();
		await ready;
		const sent = session;
		const out = await post({ jsonrpc: "2.0", id: ++id, method, params });
		if (out.status !== 404 || sent === undefined) return check(out, method);
		// The server ended the session: start a new one (MCP Streamable HTTP), unless another call already did.
		if (session === sent) {
			session = undefined;
			ready = open();
		}
		await ready;
		return check(await post({ jsonrpc: "2.0", id: ++id, method, params }), method);
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
				structuredContent?: Record<string, unknown>;
			};
			return {
				isError: r.isError === true,
				text: (r.content ?? []).map((c) => c.text ?? "").join("\n"),
				...(r.structuredContent === undefined ? {} : { structuredContent: r.structuredContent }),
			};
		},
	};
}
