#!/usr/bin/env node
// A minimal stdio MCP server for the recording-proxy tests: `echo`, `fail` (an error result), `big` (a large result),
// `slow` (answers after `ms`) and `roots` (asks its client for roots/list). It counts every tools/call on stderr.
import { createInterface } from "node:readline";

const tools = [
	{ name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
	{ name: "big", description: "Returns n characters.", inputSchema: { type: "object", properties: { n: { type: "integer" } } } },
	{ name: "slow", description: "Answers after ms.", inputSchema: { type: "object", properties: { ms: { type: "integer" } } } },
	{ name: "roots", description: "Reports the client's roots.", inputSchema: { type: "object", properties: {} } },
];
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
let calls = 0;
let nextServerId = 1000;
const waiting = new Map();

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.id !== undefined && msg.method === undefined) {
		waiting.get(msg.id)?.(msg);
		waiting.delete(msg.id);
		return;
	}
	if (msg.id === undefined) return;
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize":
			return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "Use echo first." });
		case "tools/list":
			return reply({ tools });
		case "tools/call": {
			calls++;
			process.stderr.write(`calls=${calls}\n`);
			const { name, arguments: args = {} } = msg.params;
			if (name === "echo") return reply(text(String(args.text)));
			if (name === "fail") return reply(text("fixture failure", true));
			if (name === "big") return reply(text("x".repeat(args.n ?? 10)));
			if (name === "slow") return setTimeout(() => reply(text("late")), args.ms ?? 10);
			if (name === "roots") {
				const id = nextServerId++;
				waiting.set(id, (answer) => reply(text(JSON.stringify(answer.result))));
				return send({ jsonrpc: "2.0", id, method: "roots/list" });
			}
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
		}
		default:
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
	}
});
