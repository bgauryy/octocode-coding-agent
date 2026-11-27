import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage } from "../src/types.ts";
import { describePayloadLayers } from "../src/utils/payload-layers.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const anthropicPayload = () => ({
	model: "claude",
	tools: [
		{ name: "read", input_schema: {} },
		{ name: "write", input_schema: {}, cache_control: { type: "ephemeral", ttl: "1h" } },
	],
	system: [
		{ type: "text", text: "base", cache_control: { type: "ephemeral", ttl: "1h" } },
		{ type: "text", text: "dynamic" },
	],
	messages: [
		{ role: "user", content: [{ type: "text", text: "hello" }] },
		{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		{ role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
	],
});

describe("describePayloadLayers", () => {
	it("describes an Anthropic payload in wire order with breakpoints", () => {
		const trace = describePayloadLayers("anthropic-messages", anthropicPayload());
		expect(trace?.layers.map(({ kind, role, index, breakpoint }) => ({ kind, role, index, breakpoint }))).toEqual([
			{ kind: "tools", role: undefined, index: undefined, breakpoint: true },
			{ kind: "system", role: undefined, index: 0, breakpoint: true },
			{ kind: "system", role: undefined, index: 1, breakpoint: undefined },
			{ kind: "message", role: "user", index: 0, breakpoint: undefined },
			{ kind: "message", role: "assistant", index: 1, breakpoint: undefined },
			{ kind: "message", role: "user", index: 2, breakpoint: true },
		]);
		expect(trace?.cacheMode).toBe("ephemeral-1h");
		for (const layer of trace?.layers ?? []) {
			expect(layer.hash).toMatch(/^[0-9a-f]{16}$/);
			expect(layer.chars).toBeGreaterThan(0);
		}
		expect(JSON.stringify(trace)).not.toContain("hello");
	});

	it("keeps hashes stable and changes only the edited layer's hash", () => {
		const before = describePayloadLayers("anthropic-messages", anthropicPayload())!;
		const same = describePayloadLayers("anthropic-messages", anthropicPayload())!;
		expect(same).toEqual(before);
		const edited = anthropicPayload();
		(edited.system[1] as { text: string }).text = "dynamic v2";
		const after = describePayloadLayers("anthropic-messages", edited)!;
		expect(after.layers.map((layer, i) => layer.hash !== before.layers[i].hash)).toEqual([
			false,
			false,
			true,
			false,
			false,
			false,
		]);
	});

	it("keeps the hash written by earlier versions, so stored traces still compare", () => {
		const trace = describePayloadLayers("anthropic-messages", {
			messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
		});
		expect(trace?.layers[0].hash).toBe("3337894a614ebbe1");
	});

	it("marks a breakpoint on a message whose last content part carries cache_control", () => {
		const payload = anthropicPayload();
		payload.messages[0].content = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b", cache_control: { type: "ephemeral" } },
		] as never;
		expect(describePayloadLayers("anthropic-messages", payload)?.layers[3].breakpoint).toBe(true);
	});

	it("describes OpenAI Responses input without breakpoints and reads the cache key", () => {
		const trace = describePayloadLayers("openai-responses", {
			instructions: "be brief",
			tools: [{ type: "function", name: "read" }],
			input: [
				{ role: "developer", content: "rules" },
				{ role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ type: "function_call_output", call_id: "c1", output: "ok" },
			],
			prompt_cache_key: "k",
			prompt_cache_retention: "24h",
		});
		expect(trace?.layers.map((layer) => [layer.kind, layer.role, layer.index])).toEqual([
			["tools", undefined, undefined],
			["system", undefined, 0],
			["system", "developer", 0],
			["message", "user", 1],
			["message", undefined, 2],
		]);
		expect(trace?.layers.some((layer) => layer.breakpoint)).toBe(false);
		expect(trace?.cacheMode).toBe("key+24h");
	});

	it("describes OpenAI Completions messages", () => {
		const trace = describePayloadLayers("openai-completions", {
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			tools: [{ type: "function" }],
			prompt_cache_key: "k",
		});
		expect(trace?.layers.map((layer) => [layer.kind, layer.role, layer.index])).toEqual([
			["tools", undefined, undefined],
			["system", "system", 0],
			["message", "user", 1],
		]);
		expect(trace?.cacheMode).toBe("key");
	});

	it("records each breakpoint's own TTL, not only the first marker's", () => {
		// Long instructions, short history: `cacheMode` names the first marker; the history layer keeps its 5m.
		const trace = describePayloadLayers("anthropic-messages", anthropicPayload());
		expect(trace?.layers.filter((layer) => layer.breakpoint).map(({ kind, ttl }) => ({ kind, ttl }))).toEqual([
			{ kind: "tools", ttl: "1h" },
			{ kind: "system", ttl: "1h" },
			{ kind: "message", ttl: "5m" },
		]);
		expect(trace?.layers.filter((layer) => !layer.breakpoint).every((layer) => layer.ttl === undefined)).toBe(true);
	});

	it("records an OpenAI explicit breakpoint's TTL, inherited from the request when it names none", () => {
		const input = (breakpoint: Record<string, unknown>) => [
			{ role: "developer", content: [{ type: "input_text", text: "rules", prompt_cache_breakpoint: breakpoint }] },
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		];
		const ttls = (payload: Record<string, unknown>) =>
			describePayloadLayers("openai-responses", payload)
				?.layers.filter((layer) => layer.breakpoint)
				.map((layer) => layer.ttl);
		expect(ttls({ input: input({ mode: "explicit", ttl: "12h" }), prompt_cache_options: { ttl: "30m" } })).toEqual([
			"12h",
		]);
		expect(ttls({ input: input({ mode: "explicit" }), prompt_cache_options: { ttl: "12h" } })).toEqual(["12h"]);
		expect(ttls({ input: input({ mode: "explicit" }) })).toEqual(["30m"]);
	});

	it("records a Bedrock cache point's TTL on the layer it ends", () => {
		const trace = describePayloadLayers("bedrock-converse-stream", {
			system: [{ text: "base" }, { cachePoint: { type: "default", ttl: "1h" } }],
			messages: [{ role: "user", content: [{ text: "hi" }, { cachePoint: { type: "default" } }] }],
		});
		expect(trace?.layers.map(({ kind, ttl }) => ({ kind, ttl }))).toEqual([
			{ kind: "system", ttl: "1h" },
			{ kind: "message", ttl: "5m" },
		]);
	});

	it("returns undefined for an unknown API or a non-object payload", () => {
		expect(describePayloadLayers("google-generative-ai", { contents: [] })).toBeUndefined();
		expect(describePayloadLayers("anthropic-messages", "text")).toBeUndefined();
	});
});

describe("requestTrace on an assistant message", () => {
	it("is not part of the provider payload", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "earlier answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const capturePayload = async (message: AssistantMessage): Promise<string> => {
			let payload = "";
			await anthropicStream(
				model,
				normalizeContext({
					systemPrompt: "Stable",
					messages: [
						{ role: "user", content: "hi", timestamp: 0 },
						message,
						{ role: "user", content: "again", timestamp: 2 },
					],
					tools: [{ name: "read", description: "Read", parameters: Type.Object({}) }],
				}),
				{
					apiKey: "sk-ant-api-test",
					onPayload: (value) => {
						payload = JSON.stringify(value);
						throw new Error("captured");
					},
				},
			).result();
			return payload;
		};
		const trace = describePayloadLayers("anthropic-messages", anthropicPayload());
		const plain = await capturePayload(assistant);
		expect(plain).toContain("earlier answer");
		expect(await capturePayload({ ...assistant, requestTrace: trace })).toBe(plain);
	});
});
