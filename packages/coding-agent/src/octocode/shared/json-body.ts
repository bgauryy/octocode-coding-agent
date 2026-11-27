import type { IncomingMessage } from "node:http";

/** The largest JSON request body read by default. */
const DEFAULT_MAX_BODY_BYTES = 262144;

/** The JSON body of a request, or undefined after replying 400 or 413. */
export async function readJsonBody(
	req: IncomingMessage,
	reply: (status: number, body: unknown) => void,
	maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
	if (req.headers["content-type"] !== "application/json") {
		reply(400, { error: "Use JSON" });
		return undefined;
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += (chunk as Buffer).length;
		if (bytes > maxBytes) {
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
