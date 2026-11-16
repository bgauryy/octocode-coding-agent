import { describe, expect, it } from "vitest";
import { script } from "../src/gateway.ts";
import { gateway } from "./helpers.ts";

const post = (url: string, body: unknown) =>
	fetch(`${url}/v1/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const events = (sse: string): { type: string; [k: string]: unknown }[] =>
	sse
		.split("\n\n")
		.filter(Boolean)
		.map((b) =>
			JSON.parse(
				b
					.split("\n")
					.find((l) => l.startsWith("data: "))!
					.slice(6),
			),
		);

const tools = [
	{ type: "function", name: "mcp__docs__search", description: "d", parameters: { type: "object", properties: {} } },
];

describe("POST /v1/responses", () => {
	it("maps input to messages and answers a tool call as function_call events", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "mcp__docs__search", args: { query: "x" } }] }, { text: "done" }]),
		});
		const r1 = await post(gw.url, {
			model: "m",
			stream: true,
			instructions: "be brief",
			tools,
			input: [{ role: "user", content: [{ type: "input_text", text: "find x" }] }],
		});
		const ev = events(await r1.text());
		expect(ev.map((e) => e.type)).toEqual(["response.created", "response.output_item.done", "response.completed"]);
		expect(ev[1].item).toMatchObject({ type: "function_call", name: "mcp__docs__search", arguments: '{"query":"x"}' });
		const callId = (ev[1].item as { call_id: string }).call_id;
		expect(gw.trace.requests[0]).toMatchObject({ tools: ["mcp__docs__search"], stream: true });
		expect(gw.trace.requests[0].messages.map((m) => [m.role, m.content])).toEqual([
			["system", "be brief"],
			["user", "find x"],
		]);

		const r2 = await post(gw.url, {
			model: "m",
			stream: true,
			tools,
			input: [
				{ role: "user", content: "find x" },
				{ type: "function_call", call_id: callId, name: "mcp__docs__search", arguments: '{"query":"x"}' },
				{ type: "function_call_output", call_id: callId, output: "RESULT" },
			],
		});
		const done = events(await r2.text());
		expect(done[1].item).toMatchObject({ type: "message", content: [{ type: "output_text", text: "done" }] });
		expect((done[2].response as { usage: { input_tokens: number } }).usage.input_tokens).toBeGreaterThan(0);
		const second = gw.trace.requests[1].messages;
		expect(second[1].tool_calls?.[0]).toMatchObject({ id: callId, function: { name: "mcp__docs__search" } });
		expect(second[2]).toMatchObject({ role: "tool", tool_call_id: callId, content: "RESULT" });
		expect(gw.trace).toHaveCalledTool("mcp__docs__search", { args: { query: "x" } });
	});

	it("must fail: other paths stay 404 and a missing tool call is not invented", async () => {
		const gw = await gateway({ responder: script([{ text: "plain" }]) });
		expect((await fetch(`${gw.url}/v1/nope`, { method: "POST", body: "{}" })).status).toBe(404);
		await post(gw.url, { model: "m", input: "hi" });
		expect(() => expect(gw.trace).toHaveCalledTool("mcp__docs__search")).toThrow();
	});
});
