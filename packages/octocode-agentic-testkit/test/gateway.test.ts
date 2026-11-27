import { describe, expect, it } from "vitest";
import { script, scripts } from "../src/gateway.ts";
import { chat, gateway } from "./helpers.ts";

const body = (extra: object = {}) => ({
	model: "m",
	messages: [
		{ role: "system", content: "sys" },
		{ role: "user", content: "hi" },
	],
	tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
	...extra,
});

describe("gateway", () => {
	it("captures the request and answers non-stream", async () => {
		const gw = await gateway({ responder: script([{ text: "hello" }]) });
		const r = await (await chat(gw.url, body(), { "x-testkit-agent": "planner", "x-testkit-span": "s1" })).json();
		expect(r.choices[0].message.content).toBe("hello");
		const req = gw.trace.requests[0];
		expect(req).toMatchObject({ agent: "planner", span: "s1", model: "m", stream: false, tools: ["search"] });
		expect(req.hash).toHaveLength(16);
		expect(req.bytes).toBeGreaterThan(50);
		expect(gw.trace.of("answer")[0]).toMatchObject({ agent: "planner", data: "hello" });
	});

	it("streams text as SSE with usage and [DONE]", async () => {
		const gw = await gateway({ responder: script([{ text: "a fairly long streamed answer text here" }]) });
		const raw = await (await chat(gw.url, body({ stream: true }))).text();
		const lines = raw
			.split("\n\n")
			.filter(Boolean)
			.map((l) => l.replace(/^data: /, ""));
		expect(lines.at(-1)).toBe("[DONE]");
		const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
		expect(chunks[0].choices[0].delta.role).toBe("assistant");
		const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
		expect(text).toBe("a fairly long streamed answer text here");
		expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
		expect(chunks.at(-1).usage.prompt_tokens).toBeGreaterThan(0);
	});

	it("streams tool-call deltas with index, id, name and arguments", async () => {
		const gw = await gateway({
			responder: script([
				{
					toolCalls: [
						{ name: "search", args: { query: "x" } },
						{ name: "search", args: { query: "y" } },
					],
				},
			]),
		});
		const raw = await (await chat(gw.url, body({ stream: true }))).text();
		const chunks = raw
			.split("\n\n")
			.filter((l) => l.startsWith("data: {"))
			.map((l) => JSON.parse(l.slice(6)));
		const deltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
		const heads = deltas.filter((d) => d.id);
		expect(heads.map((h) => [h.index, h.function.name])).toEqual([
			[0, "search"],
			[1, "search"],
		]);
		const args = [0, 1].map((i) =>
			JSON.parse(
				deltas
					.filter((d) => d.index === i)
					.map((d) => d.function.arguments)
					.join(""),
			),
		);
		expect(args).toEqual([{ query: "x" }, { query: "y" }]);
		expect(chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls")).toBe(true);
		expect(gw.trace.of("model_tool_call").map((e) => e.args)).toEqual([{ query: "x" }, { query: "y" }]);
	});

	it("cuts at the request cap", async () => {
		const gw = await gateway({ responder: script([{ text: "one" }]), caps: { maxRequests: 2 } });
		await chat(gw.url, body());
		await chat(gw.url, body());
		const r = await (await chat(gw.url, body())).json();
		expect(r.choices[0].message.content).toBe("testkit: request cap");
		expect(gw.trace.cut).toBe(true);
		expect(gw.trace.of("cut")).toHaveLength(1);
	});

	it("scripts per agent, last step repeats", async () => {
		const gw = await gateway({
			responder: scripts({ main: [{ text: "m1" }, { text: "m2" }], coder: [{ text: "c" }] }),
		});
		const ask = async (agent: string) =>
			(await (await chat(gw.url, body(), { "x-testkit-agent": agent })).json()).choices[0].message.content;
		expect([await ask("main"), await ask("coder"), await ask("main"), await ask("main"), await ask("coder")]).toEqual([
			"m1",
			"c",
			"m2",
			"m2",
			"c",
		]);
	});

	it("rejects a missing token and redacts secrets in canonical forms", async () => {
		const gw = await gateway({ token: "t0k" });
		expect((await chat(gw.url, body())).status).toBe(401);
		const ok = await chat(
			gw.url,
			body({ messages: [{ role: "user", content: "key sk-abcdefghijklmnop1234 at 2026-01-02" }] }),
			{ authorization: "Bearer t0k" },
		);
		expect(ok.status).toBe(200);
		expect(gw.trace.requests[0].canonical).not.toContain("sk-abcdefghijklmnop1234");
		expect(gw.trace.requests[0].canonical).toContain("<date>");
	});
});
