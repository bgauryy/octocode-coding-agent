import type { IncomingMessage, ServerResponse } from "node:http";
import { APPLICATION_PROTOCOL_VERSION, type ApplicationCursor } from "@octocodeai/octocode-contracts";

/**
 * The one access check both local web page servers apply, a session's own and the user-level daemon: the Host header is
 * the server's own `127.0.0.1:<port>`; an Origin, when a request sends one, is exactly the server's origin, and a socket
 * upgrade must send it; the token comes only from the `Authorization` header or the socket hello, never from a URL; the
 * page is served with a script-hash Content-Security-Policy header and no framing. Which tokens a server accepts and
 * what each may do stays with that server.
 */

/** Whether the request's Host header is the server's own address. */
export function ownHost(req: IncomingMessage, origin: string): boolean {
	return req.headers.host === origin.replace(/^http:\/\//, "");
}

/** Whether the request's Origin is the server's own; a missing Origin passes unless the request must carry one. */
export function ownOrigin(req: IncomingMessage, origin: string, required = false): boolean {
	return req.headers.origin === undefined ? !required : req.headers.origin === origin;
}

/** The bearer token of a request. The scheme name is case-insensitive (RFC 9110); a query string never carries a token. */
export function bearerOf(req: IncomingMessage): string {
	return (req.headers.authorization ?? "").replace(/^Bearer /i, "");
}

/** Sends the page with the headers both servers use: no caching, no referrer, no framing, the given header policy. */
export function servePage(res: ServerResponse, html: string, csp: string): void {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-frame-options": "DENY",
		"x-content-type-options": "nosniff",
		"content-security-policy": csp,
	});
	res.end(html);
}

export type SocketHello = { token: string; cursor?: ApplicationCursor } | { refusal: string };

function validCursor(value: unknown): value is ApplicationCursor {
	const cursor = value as ApplicationCursor | undefined;
	return (
		!!cursor &&
		typeof cursor.sessionId === "string" &&
		typeof cursor.epoch === "string" &&
		Number.isSafeInteger(cursor.sequence) &&
		cursor.sequence >= 0
	);
}

/**
 * A socket's first message: the bare token, or `{ token, protocolVersion, cursor? }`. A refusal is the close reason;
 * the caller checks the token itself.
 */
export function readHello(data: Buffer, binary: boolean): SocketHello {
	if (binary) return { refusal: "Reopen the workspace" };
	// The default binaryType ("nodebuffer") delivers each message as one Buffer.
	const text = data.toString();
	if (!text.startsWith("{")) return { token: text };
	let hello: { token?: unknown; protocolVersion?: unknown; cursor?: unknown };
	try {
		hello = JSON.parse(text);
	} catch {
		return { refusal: "Invalid handshake" };
	}
	if (!hello || hello.protocolVersion !== APPLICATION_PROTOCOL_VERSION || typeof hello.token !== "string")
		return { refusal: "Unsupported protocol; reopen the workspace" };
	if (hello.cursor === undefined) return { token: hello.token };
	if (!validCursor(hello.cursor)) return { refusal: "Invalid cursor" };
	return { token: hello.token, cursor: hello.cursor };
}
