import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CallToolResult } from "../client/protocol/content.ts";
import { isObject, JSON_RPC_ERROR_CODES, type JsonRpcId } from "../client/protocol/jsonrpc.ts";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from "../client/protocol/types.ts";
import { admitted, KEEPALIVE_MS, openEventStream, readBody, sendJson, sendStatus } from "./http.ts";

/** A tool the server lists, as an MCP client sees it. */
export type ServedTool = Pick<Tool, "name" | "description" | "inputSchema" | "annotations">;

/** One `tools/call`: its signal aborts when the client cancels it, disconnects or the server closes. */
export interface ServedCall {
	/** The JSON-RPC id of the request, unique while it runs. */
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	signal: AbortSignal;
}

interface ToolServerOptions {
	name: string;
	version: string;
	/** The tools listed now; read on every `tools/list`. */
	tools(): readonly ServedTool[];
	/** Answers one call. The server runs no tool itself; a rejection is answered as an error result. */
	call(call: ServedCall): Promise<CallToolResult>;
	instructions?: string;
}

/** A running server: where it listens, the header that admits a client, and its controls. */
export interface ToolServer {
	readonly url: string;
	/** `Authorization: Bearer <token>`: the only credential the server accepts, made for this server alone. */
	readonly headers: Readonly<Record<string, string>>;
	/** Tells every connected client that the tool list changed. */
	toolsChanged(): void;
	/** Stops listening, aborts the calls in flight and closes every stream. */
	close(): Promise<void>;
}

type Request = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown };

const failure = (id: JsonRpcId | null, code: number, message: string) => ({
	jsonrpc: "2.0",
	id,
	error: { code, message },
});

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * An MCP server (Streamable HTTP, 2025-03-26 and later) that lists a host's tools and hands each call back to the host:
 * on loopback only, on a port of its own, admitting only a client that presents its bearer token. A call's answer
 * streams as a server-sent event, so an approval that takes a while keeps the request open with keepalive comments
 * instead of tripping the client's header timeout.
 */
export async function serveTools(options: ToolServerOptions): Promise<ToolServer> {
	const token = randomBytes(32).toString("base64url");
	const secret = Buffer.from(token);
	const sessions = new Set<string>();
	/** The clients' GET streams, where notifications go. */
	const listeners = new Set<ReturnType<typeof openEventStream>>();
	const calls = new Map<string, AbortController>();
	const lifetime = new AbortController();
	let port = 0;

	const call = async (request: Request, response: ServerResponse): Promise<void> => {
		const params = isObject(request.params) ? request.params : {};
		const name = typeof params.name === "string" ? params.name : "";
		const args = isObject(params.arguments) ? params.arguments : {};
		const id = String(request.id);
		const controller = new AbortController();
		calls.set(id, controller);
		const closed = () => {
			if (!response.writableFinished) controller.abort(new Error("The MCP client closed the call."));
		};
		response.once("close", closed);
		const stream = openEventStream(response);
		const keepalive = setInterval(() => stream.ping(), KEEPALIVE_MS);
		keepalive.unref?.();
		try {
			const known = options.tools().some((tool) => tool.name === name);
			const result = !known
				? errorResult(`Unknown tool: ${name}`)
				: await options
						.call({ id, name, arguments: args, signal: AbortSignal.any([controller.signal, lifetime.signal]) })
						.catch((error: unknown) => errorResult(error instanceof Error ? error.message : String(error)));
			stream.send({ jsonrpc: "2.0", id: request.id, result });
		} finally {
			clearInterval(keepalive);
			calls.delete(id);
			response.off("close", closed);
			response.end();
		}
	};

	const answer = (request: Request, response: ServerResponse): void => {
		const reply = (result: unknown, headers?: Record<string, string>) =>
			sendJson(response, 200, { jsonrpc: "2.0", id: request.id, result }, headers);
		if (request.method === "initialize") {
			const asked = isObject(request.params) ? request.params.protocolVersion : undefined;
			const version = SUPPORTED_PROTOCOL_VERSIONS.find((supported) => supported === asked) ?? LATEST_PROTOCOL_VERSION;
			const session = randomUUID();
			sessions.add(session);
			reply(
				{
					protocolVersion: version,
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: options.name, version: options.version },
					...(options.instructions ? { instructions: options.instructions } : {}),
				},
				{ "mcp-session-id": session },
			);
		} else if (request.method === "ping") reply({});
		else if (request.method === "tools/list")
			reply({
				tools: options.tools().map(({ name, description, inputSchema, annotations }) => ({
					name,
					...(description ? { description } : {}),
					inputSchema,
					...(annotations ? { annotations } : {}),
				})),
			});
		else
			sendJson(
				response,
				200,
				failure(request.id, JSON_RPC_ERROR_CODES.methodNotFound, `Unknown method ${request.method}`),
			);
	};

	const post = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body = await readBody(request);
		if (body === undefined) return sendStatus(response, 413);
		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch {
			return sendJson(response, 400, failure(null, JSON_RPC_ERROR_CODES.parseError, "Invalid JSON"));
		}
		if (!isObject(message) || message.jsonrpc !== "2.0")
			return sendJson(response, 400, failure(null, JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message"));
		const session = request.headers["mcp-session-id"];
		if (message.method !== "initialize" && typeof session === "string" && !sessions.has(session))
			return sendStatus(response, 404);
		if (typeof message.method !== "string" || !("id" in message)) {
			// A notification or a client's response: only cancellation means anything here.
			const requestId = isObject(message.params) ? message.params.requestId : undefined;
			if (
				message.method === "notifications/cancelled" &&
				(typeof requestId === "string" || typeof requestId === "number")
			)
				calls.get(String(requestId))?.abort(new Error("The MCP client cancelled the call."));
			return sendStatus(response, 202);
		}
		const rpc = message as Request;
		if (rpc.method === "tools/call") return call(rpc, response);
		answer(rpc, response);
	};

	const listen = (request: IncomingMessage, response: ServerResponse): void => {
		if (!(request.headers.accept ?? "").includes("text/event-stream")) return sendStatus(response, 405);
		const stream = openEventStream(response);
		listeners.add(stream);
		const keepalive = setInterval(() => stream.ping(), KEEPALIVE_MS);
		keepalive.unref?.();
		response.once("close", () => {
			clearInterval(keepalive);
			listeners.delete(stream);
		});
		lifetime.signal.addEventListener("abort", () => response.end(), { once: true });
	};

	const server: Server = createServer((request, response) => {
		const refused = admitted(request, port, secret);
		if (refused) return sendStatus(response, refused);
		if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") return sendStatus(response, 404);
		if (request.method === "GET") return listen(request, response);
		if (request.method === "DELETE") {
			const session = request.headers["mcp-session-id"];
			if (typeof session === "string") sessions.delete(session);
			return sendStatus(response, 200);
		}
		if (request.method !== "POST") return sendStatus(response, 405);
		post(request, response).catch(() => {
			if (!response.headersSent) sendStatus(response, 500);
			else response.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("The MCP tool server did not bind to a TCP port.");
	port = address.port;
	let closing: Promise<void> | undefined;

	return {
		url: `http://127.0.0.1:${port}/mcp`,
		headers: Object.freeze({ Authorization: `Bearer ${token}` }),
		toolsChanged: () => {
			for (const stream of listeners) stream.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		},
		close: () =>
			(closing ??= new Promise<void>((resolve) => {
				lifetime.abort(new Error("The MCP tool server closed."));
				server.close(() => resolve());
				server.closeAllConnections();
			})),
	};
}
