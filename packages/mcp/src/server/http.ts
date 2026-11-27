import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The largest request body the server reads; a tool call's arguments are far smaller. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** A comment line on every open event stream this often, so no idle timer between the two ends closes it. */
export const KEEPALIVE_MS = 15_000;

/**
 * Whether a request may reach the server: sent to this loopback port by its own host name (no DNS rebinding), from no
 * web page but one on that origin, and carrying the session's bearer token. The token is compared in constant time.
 */
export function admitted(request: IncomingMessage, port: number, token: Buffer): number | undefined {
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	if (!hosts.has(request.headers.host ?? "")) return 403;
	const origin = request.headers.origin;
	if (origin !== undefined && !hosts.has(origin.replace(/^http:\/\//, ""))) return 403;
	const given = Buffer.from(/^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");
	if (given.length !== token.length || !timingSafeEqual(given, token)) return 401;
	return undefined;
}

/** The request body as text, or undefined past {@link MAX_BODY_BYTES}. */
export async function readBody(request: IncomingMessage): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) {
	response.writeHead(status, { "content-type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

export function sendStatus(response: ServerResponse, status: number): void {
	response.writeHead(status);
	response.end();
}

/** Opens an event stream on `response`; writes go out as `message` events. */
export function openEventStream(response: ServerResponse): { send(message: unknown): void; ping(): void } {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	response.flushHeaders();
	const open = () => !response.writableEnded && !response.destroyed;
	return {
		send: (message) => {
			if (open()) response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
		},
		ping: () => {
			if (open()) response.write(": keepalive\n\n");
		},
	};
}
