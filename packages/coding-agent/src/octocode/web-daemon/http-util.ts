import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Reply = (status: number, body: unknown, headers?: Record<string, string>) => void;

const MAX_BODY_BYTES = 262144;

export function replier(res: ServerResponse): Reply {
	return (status, body, headers) => {
		if (res.headersSent) return;
		res.writeHead(status, {
			...headers,
			"content-type": "application/json",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		res.end(JSON.stringify(body));
	};
}

/** Constant-time comparison of a presented token with the expected one. */
function tokenMatches(supplied: string, expected: string): boolean {
	const a = Buffer.from(supplied);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** The daemon's three capabilities. `launch` is the local browser's and CLI's; `remote` and `view` go into published links. */
export interface DaemonTokens {
	launch: string;
	remote: string;
	view: string;
}

/** What a presented token is: `launch` (the page's full surface and every admin route), `remote` (the same page, no admin), `view` (reads only). */
export type TokenAccess = "launch" | "remote" | "view";

/** Which capability a presented token is, or undefined. Every comparison always runs. */
export function tokenAccess(supplied: string, tokens: DaemonTokens): TokenAccess | undefined {
	const launch = tokenMatches(supplied, tokens.launch);
	const remote = tokenMatches(supplied, tokens.remote);
	const view = tokenMatches(supplied, tokens.view);
	return launch ? "launch" : remote ? "remote" : view ? "view" : undefined;
}

/** The bearer token of a request (the `Authorization` header only; a query string never carries one). */
export function bearerOf(req: IncomingMessage): string {
	return (req.headers.authorization ?? "").replace(/^Bearer /, "");
}

/** The JSON body of a request, or undefined after replying 400 or 413. */
export async function readJsonBody(req: IncomingMessage, reply: Reply): Promise<unknown> {
	if (req.headers["content-type"] !== "application/json") {
		reply(400, { error: "Use JSON" });
		return undefined;
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += (chunk as Buffer).length;
		if (bytes > MAX_BODY_BYTES) {
			reply(413, { error: "Request too large" });
			return undefined;
		}
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		reply(400, { error: "Invalid JSON" });
		return undefined;
	}
}
