import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmp } from "./helpers.ts";
import { converseStream } from "./provider-wire-eventstream.ts";
import { type StreamedReply, streamedBody } from "./provider-wire-replies.ts";

/**
 * A loopback model provider for the four wire families, plus a no-network guard for the real CLI process a test starts.
 * It records every request (path, headers, parsed body) and answers from a queue of replies, so a test shows what a
 * session put on the wire after models.json, the registry and the credential resolver had their say.
 */
export type Family =
	| "bedrock-converse-stream"
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export interface Seen {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: any;
	/** Milliseconds since the epoch when the request arrived. */
	at: number;
}

/** `ok` is a normal streamed reply; anything else is an HTTP failure with its own body and headers. */
export type Reply = "ok" | StreamedReply | { status: number; body?: string; headers?: Record<string, string> };

export interface Wire {
	/** The address, no path: models.json's `baseUrl` is this plus `baseSuffix(family)`. */
	url: string;
	seen: Seen[];
	/** Replies consumed one per model request; the last one repeats. */
	replies: Reply[];
	close(): Promise<void>;
}

export const REPLY_TEXT = "wire-reply-ok";

/** The path part of `baseUrl` each family's client expects. */
export const baseSuffix = (family: Family): string =>
	family === "openai-completions" || family === "openai-responses" ? "/v1" : "";

const USAGE = { input: 11, output: 3 };

const sse = (events: Array<{ event?: string; data: unknown }>): string =>
	events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("");

function okBody(family: Family, model: string): string | Buffer {
	if (family === "bedrock-converse-stream") return converseStream(REPLY_TEXT);
	if (family === "openai-completions") {
		const chunk = (choice: Record<string, unknown>, extra = {}) => ({
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [{ index: 0, ...choice }],
			...extra,
		});
		return `${sse([
			{ data: chunk({ delta: { role: "assistant", content: REPLY_TEXT } }) },
			{
				data: chunk(
					{ delta: {}, finish_reason: "stop" },
					{ usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
				),
			},
		])}data: [DONE]\n\n`;
	}
	if (family === "openai-responses") {
		const message = {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: REPLY_TEXT, annotations: [] }],
		};
		const base = { id: "resp_1", created_at: 1, model };
		return sse([
			{ data: { type: "response.created", response: base } },
			{
				data: {
					type: "response.output_item.added",
					output_index: 0,
					item: { ...message, status: "in_progress", content: [] },
				},
			},
			{
				data: {
					type: "response.output_text.delta",
					item_id: "msg_1",
					output_index: 0,
					content_index: 0,
					delta: REPLY_TEXT,
				},
			},
			{ data: { type: "response.output_item.done", output_index: 0, item: message } },
			{
				data: {
					type: "response.completed",
					response: {
						...base,
						status: "completed",
						output: [message],
						usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
					},
				},
			},
		]);
	}
	if (family === "anthropic-messages") {
		return sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "msg_1", model, usage: { input_tokens: USAGE.input, output_tokens: 0 } },
				},
			},
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY_TEXT } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: USAGE.output },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
	}
	return sse([
		{
			data: {
				candidates: [{ index: 0, content: { role: "model", parts: [{ text: REPLY_TEXT }] }, finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
			},
		},
	]);
}

const isModelRequest = (family: Family, url: string): boolean =>
	family === "openai-completions"
		? url.endsWith("/chat/completions")
		: family === "openai-responses"
			? url.endsWith("/responses")
			: family === "bedrock-converse-stream"
				? url.endsWith("/converse-stream")
				: family === "anthropic-messages"
					? url.endsWith("/messages")
					: /:streamGenerateContent/.test(url);

/** Starts the fake on 127.0.0.1. Requests that are not a model request answer 404 and are not recorded. */
export async function startWire(family: Family, replies: Reply[] = ["ok"]): Promise<Wire> {
	const seen: Seen[] = [];
	const wire: Wire = { url: "", seen, replies: [...replies], close: async () => undefined };
	const server = http.createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			const url = request.url ?? "";
			if (request.method !== "POST" || !isModelRequest(family, url.split("?")[0] ?? "")) {
				return void response.writeHead(404).end();
			}
			const body = raw ? JSON.parse(raw) : undefined;
			seen.push({ method: request.method, path: url, headers: request.headers, body, at: Date.now() });
			const reply = wire.replies.length > 1 ? wire.replies.shift()! : (wire.replies[0] ?? "ok");
			if (typeof reply === "object" && !("status" in reply)) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				return void response.end(streamedBody(family, String(body?.model ?? "model"), reply));
			}
			if (reply !== "ok") {
				response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
				return void response.end(reply.body ?? JSON.stringify({ error: { message: `scripted ${reply.status}` } }));
			}
			response.writeHead(200, {
				"content-type":
					family === "bedrock-converse-stream" ? "application/vnd.amazon.eventstream" : "text/event-stream",
			});
			response.end(okBody(family, String(body?.model ?? "model")));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	wire.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	wire.close = () =>
		new Promise((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	return wire;
}

/** The model text a request sent, whatever the family calls its message list. */
export function sentText(seen: Seen): string {
	return JSON.stringify(seen.body?.messages ?? seen.body?.input ?? seen.body?.contents ?? "");
}

/**
 * Makes a process fail any socket to a non-loopback host and log it. Put the returned `env` in a sandbox's environment
 * and assert `violations()` is empty after the run: a request that left the machine is a failed test.
 */
export function networkGuard(): { env: NodeJS.ProcessEnv; violations(): string[] } {
	const log = path.join(fs.realpathSync(tmp("octocode-net-guard-")), "violations.log");
	const preload = fileURLToPath(new URL("./provider-wire-guard.mjs", import.meta.url));
	return {
		env: { NODE_OPTIONS: `--import ${preload}`, OCTOCODE_TEST_NET_LOG: log },
		violations: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
	};
}
