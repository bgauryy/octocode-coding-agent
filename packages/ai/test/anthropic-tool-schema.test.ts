import { describe, expect, it } from "vitest";
import { anthropicSdkTools } from "../src/api/ai-sdk/anthropic-map.ts";
import { streamSdk } from "../src/api/ai-sdk/stream.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

async function sentTools(tools: Tool[], supportsStrictTools = false, disablePreferredStrictTools = false) {
	const model: Model<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-haiku-4-5",
		name: "Test",
		baseUrl: "https://anthropic.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 100,
	};
	let body: { tools: { input_schema: unknown; strict?: boolean }[] } | undefined;
	let calls = 0;
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const result = await streamSdk(
		model,
		normalizeContext({ tools, messages: [{ role: "user", content: "Hello", timestamp: 0 }] }),
		{
			apiKey: "test-key",
			fetch: async (_input, init) => {
				calls++;
				body = JSON.parse(init?.body as string);
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
		{ tools: anthropicSdkTools(tools, supportsStrictTools, disablePreferredStrictTools) },
	).result();
	expect(result.errorMessage).toBeUndefined();
	expect(body).toBeDefined();
	expect(calls).toBe(1);
	return body!.tools;
}

const schema = {
	type: "object",
	properties: { filter: { $ref: "#/$defs/Filter" } },
	required: ["filter"],
	additionalProperties: false,
	$defs: { Filter: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false } },
} as const;

const constrained = (strict: "prefer" | "require"): Tool => ({
	name: "lookup",
	description: "Lookup",
	parameters: {
		type: "object",
		properties: { value: { type: "string" }, optional: { type: "number" } },
		required: ["value"],
	},
	constrainedSampling: { type: "json_schema", strict },
});

describe("Anthropic SDK strict tool mapping", () => {
	it.each(["prefer", "require"] as const)("serializes %s schemas strictly", async (strict) => {
		const [sent] = await sentTools([constrained(strict)], true);
		expect(sent.strict).toBe(true);
		expect(sent.input_schema).toEqual({
			type: "object",
			properties: { value: { type: "string" }, optional: { anyOf: [{ type: "number" }, { type: "null" }] } },
			required: ["value", "optional"],
			additionalProperties: false,
		});
	});
	it("downgrades only prefer and restores its original schema", async () => {
		const preferred = constrained("prefer");
		const required = { ...constrained("require"), name: "required" };
		const before = JSON.stringify([preferred, required]);
		const [first, second] = await sentTools([preferred, required], true, true);
		expect(first.strict).toBeUndefined();
		expect(first.input_schema).toEqual(preferred.parameters);
		expect(second.strict).toBe(true);
		expect(JSON.stringify([preferred, required])).toBe(before);
	});
	it("leaves prefer non-strict when strict tools are unsupported", async () => {
		const preferred = constrained("prefer");
		const [sent] = await sentTools([preferred]);
		expect(sent.strict).toBeUndefined();
		expect(sent.input_schema).toEqual(preferred.parameters);
	});
	it("rejects require when strict tools are unsupported", () => {
		expect(() => anthropicSdkTools([constrained("require")], false)).toThrow("strict tools are unsupported");
	});
	it("rejects unsupported grammar rather than silently dropping it", () => {
		const definition: Tool = {
			...constrained("prefer"),
			constrainedSampling: {
				type: "grammar",
				variants: { openai_regex: "[a-z]+" },
			},
		};
		expect(() => anthropicSdkTools([definition], true)).toThrow("Anthropic grammar tools are unsupported");
	});
});

describe("Anthropic non-strict tool conversion", () => {
	it("keeps $defs and additionalProperties so a $ref does not dangle", async () => {
		const tool = { name: "search", description: "Search", parameters: schema } as unknown as Tool;
		const [converted] = await sentTools([tool]);
		expect(converted.input_schema).toEqual({
			type: "object",
			properties: schema.properties,
			required: ["filter"],
			additionalProperties: false,
			$defs: schema.$defs,
		});
	});

	it("keeps draft-07 definitions too and adds no keys a schema lacks", async () => {
		const legacy = {
			type: "object",
			properties: { a: { $ref: "#/definitions/A" } },
			definitions: { A: { type: "string" } },
		};
		const plain = { type: "object", properties: { a: { type: "string" } } };
		const [withDefinitions, without] = await sentTools([
			{ name: "one", description: "One", parameters: legacy },
			{ name: "two", description: "Two", parameters: plain },
		] as Tool[]);
		expect(withDefinitions.input_schema).toMatchObject({ definitions: legacy.definitions, required: [] });
		expect(without.input_schema).toEqual({ type: "object", properties: plain.properties, required: [] });
	});
});
