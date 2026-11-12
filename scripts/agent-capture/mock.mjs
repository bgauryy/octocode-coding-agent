#!/usr/bin/env node
/**
 * A local model endpoint that logs every request (method, URL, headers with credentials redacted, body) as
 * `<dir>/NNN.json` and answers with a minimal stream: Anthropic Messages (`/v1/messages`) and OpenAI Responses
 * (`/v1/responses`). With `tool: true` the first answer to a request that offers a shell tool is one `ls -la` call, so
 * the client's second request shows how it sends a tool result.
 *
 *   node scripts/agent-capture/mock.mjs <port> <dir> [--tool]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const REDACT = new Set(["authorization", "x-api-key", "cookie", "chatgpt-account-id", "proxy-authorization"]);
const SHELLS = ["Bash", "bash", "shell", "exec_command", "shell_command"];

function sse(response, events) {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	response.end();
}

const hasToolResult = (body) =>
	/tool_result|function_call_output/.test(JSON.stringify(body.messages ?? body.input ?? []));
const shellArguments = (name) =>
	name === "shell" ? { command: ["ls", "-la"] } : name === "exec_command" ? { cmd: "ls -la" } : { command: "ls -la" };

function anthropic(response, body, tool) {
	const message = {
		id: "msg_mock",
		type: "message",
		role: "assistant",
		model: body.model,
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 1 },
	};
	const shell = (body.tools ?? []).find((candidate) => SHELLS.includes(candidate.name));
	const block =
		tool && body.stream && shell && !hasToolResult(body)
			? {
					start: { type: "tool_use", id: "toolu_mock1", name: shell.name, input: {} },
					delta: { type: "input_json_delta", partial_json: JSON.stringify(shellArguments(shell.name)) },
					stop: "tool_use",
				}
			: { start: { type: "text", text: "" }, delta: { type: "text_delta", text: "OK" }, stop: "end_turn" };
	if (!body.stream) {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ...message, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }));
		return;
	}
	sse(response, [
		["message_start", { type: "message_start", message }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: block.start }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: block.delta }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{ type: "message_delta", delta: { stop_reason: block.stop, stop_sequence: null }, usage: { output_tokens: 1 } },
		],
		["message_stop", { type: "message_stop" }],
	]);
}

function responses(response, body, tool) {
	const usage = {
		input_tokens: 1,
		output_tokens: 1,
		total_tokens: 2,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	};
	const shell = (body.tools ?? []).find((candidate) => SHELLS.includes(candidate.name));
	const item =
		tool && shell && !hasToolResult(body)
			? {
					type: "function_call",
					id: "fc_mock",
					call_id: "call_mock1",
					name: shell.name,
					arguments: JSON.stringify(shellArguments(shell.name)),
					status: "completed",
				}
			: {
					type: "message",
					id: "msg_mock",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "OK", annotations: [] }],
				};
	const done = { id: "resp_mock", object: "response", status: "completed", model: body.model, output: [item], usage };
	// A text answer streams as a client expects to show it: the item, its text delta, then the finished item.
	const text =
		item.type === "message"
			? [
					[
						"response.output_item.added",
						{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
					],
					[
						"response.output_text.delta",
						{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "OK" },
					],
				]
			: [];
	sse(response, [
		["response.created", { type: "response.created", response: { ...done, status: "in_progress", output: [] } }],
		...text,
		["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
		["response.completed", { type: "response.completed", response: done }],
	]);
}

/** Starts the mock on `port` (0: any free port) and resolves once it listens; `close()` stops it. */
export function startMock({ dir, port = 0, tool = false }) {
	mkdirSync(dir, { recursive: true });
	let count = 0;
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body;
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				body = { raw };
			}
			const headers = Object.fromEntries(
				Object.entries(request.headers).map(([key, value]) => [key, REDACT.has(key) ? "<redacted>" : value]),
			);
			const id = String(++count).padStart(3, "0");
			writeFileSync(
				`${dir}/${id}.json`,
				`${JSON.stringify({ method: request.method, url: request.url, headers, body }, null, 2)}\n`,
			);
			const path = (request.url ?? "").split("?")[0];
			if (path.endsWith("/messages")) return anthropic(response, body, tool);
			if (path.endsWith("/responses")) return responses(response, body, tool);
			response.writeHead(path.endsWith("/models") ? 200 : 404, { "content-type": "application/json" });
			response.end(
				JSON.stringify(
					path.endsWith("/models") ? { data: [], models: [] } : { error: { message: "mock: not handled" } },
				),
			);
		});
	});
	return new Promise((resolveStart, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () =>
			resolveStart({
				port: server.address().port,
				requests: () => count,
				close: () => new Promise((done) => server.close(() => done())),
			}),
		);
	});
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
	const [port = "8787", dir = "./out"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
	const mock = await startMock({ dir, port: Number(port), tool: process.argv.includes("--tool") });
	console.log(`mock on 127.0.0.1:${mock.port} -> ${dir}`);
}
