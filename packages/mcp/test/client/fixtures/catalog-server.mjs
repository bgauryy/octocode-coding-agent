import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// A stdio MCP server with one tool, two resources, one resource template and one prompt. Every request method is
// appended to MCP_FIXTURE_LOG when set, so a test can assert what the client asked.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const reply = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
const TEXTS = { "fixture://guide": "Read me first.\nSecond line." };

for await (const line of lines) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, `${message.method}\n`);
	const params = message.params ?? {};
	if (message.method === "initialize")
		reply(message.id, {
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {}, resources: {}, prompts: {} },
				serverInfo: { name: "catalog-fixture", version: "1.0.0" },
			},
		});
	else if (message.method === "tools/list")
		reply(message.id, { result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
	else if (message.method === "resources/list")
		reply(message.id, {
			result: {
				resources: [
					{ uri: "fixture://guide", name: "guide", description: "How to use the fixture", mimeType: "text/markdown" },
					{ uri: "fixture://logo", name: "logo", mimeType: "application/octet-stream" },
				],
			},
		});
	else if (message.method === "resources/templates/list")
		reply(message.id, { result: { resourceTemplates: [{ uriTemplate: "fixture://file/{path}", name: "file" }] } });
	else if (message.method === "resources/read") {
		if (TEXTS[params.uri] !== undefined)
			reply(message.id, { result: { contents: [{ uri: params.uri, mimeType: "text/markdown", text: TEXTS[params.uri] }] } });
		else if (params.uri === "fixture://logo")
			reply(message.id, { result: { contents: [{ uri: params.uri, mimeType: "application/octet-stream", blob: "AAEC" }] } });
		else reply(message.id, { error: { code: -32002, message: `Resource not found: ${params.uri}` } });
	} else if (message.method === "prompts/list")
		reply(message.id, {
			result: {
				prompts: [
					{
						name: "review",
						description: "Review a file",
						arguments: [{ name: "path", required: true }, { name: "focus" }],
					},
				],
			},
		});
	else if (message.method === "prompts/get")
		reply(message.id, {
			result: {
				messages: [
					{ role: "user", content: { type: "text", text: `Review ${params.arguments.path}` } },
					{ role: "user", content: { type: "text", text: `Focus: ${params.arguments.focus ?? "all"}` } },
				],
			},
		});
	else if (message.method === "ping") reply(message.id, { result: {} });
	else reply(message.id, { error: { code: -32601, message: "not found" } });
}
