import type { IncomingMessage, ServerResponse } from "node:http";

/** A JSON-RPC request as the mock reads it. */
export type Rpc = { id: number | string | null; method: string; params?: Record<string, unknown> };

/** The JSON-RPC error codes the mock answers with (MCP adds the session and resource codes). */
export const RPC_ERROR = {
	parse: -32700,
	invalidRequest: -32600,
	noMethod: -32601,
	invalidParams: -32602,
	internal: -32603,
	sessionNotFound: -32001,
	resourceNotFound: -32002,
} as const;

/** A method handler throws one to answer with a JSON-RPC error. */
export class RpcFailure extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** What one POST body is: a request to answer, a message to accept with 202, or an error to answer with 400. */
export type Incoming =
	| { kind: "request"; rpc: Rpc }
	| { kind: "accepted" }
	| { kind: "invalid"; code: number; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseMessage(raw: string): Incoming {
	let msg: unknown;
	try {
		msg = JSON.parse(raw);
	} catch {
		return { kind: "invalid", code: RPC_ERROR.parse, message: "Parse error: the body is not JSON" };
	}
	if (Array.isArray(msg))
		return {
			kind: "invalid",
			code: RPC_ERROR.invalidRequest,
			message: "Invalid Request: JSON-RPC batches are not supported (MCP removed them in 2025-06-18)",
		};
	if (!isRecord(msg) || (typeof msg.method !== "string" && !("result" in msg || "error" in msg)))
		return { kind: "invalid", code: RPC_ERROR.invalidRequest, message: "Invalid Request: not a JSON-RPC message" };
	// A notification, or the client's response to a server request.
	if (typeof msg.method !== "string" || msg.id === undefined) return { kind: "accepted" };
	return { kind: "request", rpc: msg as Rpc };
}

export const rpcError = (id: Rpc["id"], code: number, message: string) => ({
	jsonrpc: "2.0",
	id,
	error: { code, message },
});

export function send(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export const header = (req: IncomingMessage, k: string): string | undefined => {
	const v = req.headers[k];
	return Array.isArray(v) ? v[0] : v;
};
