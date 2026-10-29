import { describe, expect, it, vi } from "vitest";
import { getCompat } from "../src/api/openai-completions/compat.ts";
import { sanitizeMoonshotToolParameters } from "../src/api/openai-completions/tool-schema-flavor.ts";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model, Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: {}, finish_reason: "stop" }] };
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

/** The shape the Kimi API rejected: a type-less `const`, a type-less `enum`, an empty schema, and a typed union parent. */
const KIMI_REJECTED_SCHEMA = {
	type: "object",
	additionalProperties: false,
	anyOf: [
		{
			properties: {
				queries: {
					type: "array",
					items: {
						anyOf: [
							{
								properties: {
									operation: { const: "resolve" },
									ecosystem: { const: "npm" },
									registryUrl: {},
								},
								required: ["operation", "ecosystem"],
							},
							{
								properties: {
									operation: { const: "search" },
									keywords: { type: "array", items: { type: "string" } },
									ecosystem: { enum: ["crates", "maven"] },
								},
								required: ["operation"],
							},
						],
					},
				},
				required: ["queries"],
			},
		},
		{
			properties: { cursor: { type: "string", minLength: 1 } },
			required: ["cursor"],
			additionalProperties: false,
		},
	],
};

async function capturedToolParameters(
	model: Model<"openai-completions">,
	tool: Tool,
): Promise<Record<string, unknown>> {
	let payload: unknown;
	mockState.lastParams = undefined;
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Call the tool", timestamp: Date.now() }], tools: [tool] },
		{
			apiKey: "test",
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();
	const params = (payload ?? mockState.lastParams) as {
		tools?: Array<{ function?: { parameters?: Record<string, unknown> } }>;
	};
	return params.tools?.[0]?.function?.parameters ?? {};
}

describe("sanitizeMoonshotToolParameters", () => {
	it("adds a type to type-less const, enum and empty schemas", () => {
		const sanitized = sanitizeMoonshotToolParameters({
			type: "object",
			properties: {
				ecosystem: { const: "npm" },
				level: { enum: ["patch", "minor"] },
				anything: {},
				numbered: { const: 3 },
				flag: { const: true },
			},
		});
		expect(sanitized.properties).toMatchObject({
			ecosystem: { const: "npm", type: "string" },
			level: { enum: ["patch", "minor"], type: "string" },
			anything: { type: "string" },
			numbered: { const: 3, type: "integer" },
			flag: { const: true, type: "boolean" },
		});
	});

	it("falls back to string for mixed-type enum and const values", () => {
		const sanitized = sanitizeMoonshotToolParameters({
			type: "object",
			properties: {
				mixedBoolNumber: { enum: [true, 1] },
				mixedStringNumber: { enum: ["a", 1] },
				mixedNumberBool: { enum: [1, true] },
				homogeneousNumbers: { enum: [1, 2, 3] },
			},
		});
		expect(sanitized.properties).toMatchObject({
			mixedBoolNumber: { enum: [true, 1], type: "string" },
			mixedStringNumber: { enum: ["a", 1], type: "string" },
			mixedNumberBool: { enum: [1, true], type: "string" },
			homogeneousNumbers: { enum: [1, 2, 3], type: "integer" },
		});
	});

	it("moves a type off a union parent onto its children and infers object children", () => {
		const sanitized = sanitizeMoonshotToolParameters({
			type: "object",
			properties: {
				query: {
					type: "object",
					anyOf: [{ properties: { fresh: { type: "boolean" } } }, { description: "saved response" }],
				},
			},
		});
		const query = (sanitized.properties as Record<string, Record<string, unknown>>).query;
		expect(query.type).toBeUndefined();
		expect(query.anyOf).toEqual([
			{ properties: { fresh: { type: "boolean" } }, type: "object" },
			{ description: "saved response", type: "string" },
		]);
	});

	it("keeps the required root object type when the root is a union and types each branch", () => {
		const sanitized = sanitizeMoonshotToolParameters(KIMI_REJECTED_SCHEMA);
		// Nested union parents drop type, but the API requires tools.function.parameters.type = object.
		expect(sanitized.type).toBe("object");
		expect(sanitized.properties).toEqual({});
		const firstBranch = (sanitized.anyOf as Array<Record<string, unknown>>)[0];
		expect(firstBranch.type).toBe("object");
		const items = ((firstBranch.properties as Record<string, unknown>).queries as Record<string, unknown>)
			.items as Record<string, unknown>;
		expect(items.type).toBeUndefined();
		const rows = items.anyOf as Array<Record<string, Record<string, unknown>>>;
		expect(rows[0]?.properties?.ecosystem).toMatchObject({ const: "npm", type: "string" });
		expect(rows[0]?.properties?.operation).toMatchObject({ const: "resolve", type: "string" });
		expect(rows[0]?.properties?.registryUrl).toEqual({ type: "string" });
		expect(rows[1]?.properties?.ecosystem).toMatchObject({ enum: ["crates", "maven"], type: "string" });
	});

	it("repairs $defs subschemas but leaves $ref nodes alone", () => {
		const sanitized = sanitizeMoonshotToolParameters({
			type: "object",
			$defs: { name: { const: "npm" } },
			properties: { ecosystem: { $ref: "#/$defs/name" } },
		});
		expect(sanitized.$defs).toEqual({ name: { const: "npm", type: "string" } });
		expect((sanitized.properties as Record<string, unknown>).ecosystem).toEqual({ $ref: "#/$defs/name" });
	});

	it("converts boolean subschemas to MFJS object forms but leaves boolean keyword values alone", () => {
		const sanitized = sanitizeMoonshotToolParameters({
			type: "object",
			properties: {
				extra: true,
				disabled: false,
				nested: { anyOf: [true, false] },
				list: { items: true },
			},
			additionalProperties: false,
		});
		expect((sanitized.properties as Record<string, Record<string, unknown>>).extra).toMatchObject({
			type: "string",
		});
		expect((sanitized.properties as Record<string, Record<string, unknown>>).disabled).toEqual({
			type: "string",
		});
		expect((sanitized.properties as Record<string, Record<string, unknown>>).nested).toEqual({
			anyOf: [{ type: "string" }, { type: "string" }],
		});
		expect((sanitized.properties as Record<string, Record<string, unknown>>).list).toMatchObject({
			items: { type: "string" },
		});
		// Boolean keyword values stay untouched.
		expect(sanitized.additionalProperties).toBe(false);
	});

	it("does not mutate the input schema", () => {
		const input = { type: "object", properties: { ecosystem: { const: "npm" } } };
		sanitizeMoonshotToolParameters(input);
		expect(input.properties).toEqual({ ecosystem: { const: "npm" } });
	});

	it("turns non-object parameters into a bare object schema", () => {
		expect(sanitizeMoonshotToolParameters([])).toEqual({
			type: "object",
			properties: {},
		});
	});
});

describe("moonshot tool schema flavor detection", () => {
	const localModel = {
		api: "openai-completions",
		provider: "local-vllm",
		baseUrl: "http://localhost:8000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		id: "local-model",
		name: "Local Model",
	} satisfies Model<"openai-completions">;
	const tool: Tool = { name: "artifactSearch", description: "Search packages", parameters: KIMI_REJECTED_SCHEMA };

	it("detects moonshot for the Kimi API providers and endpoints", () => {
		const model = getBuiltinModel("moonshotai", "kimi-k2.6");
		expect(getCompat(model).toolSchemaFlavor).toBe("moonshot");
	});

	it("detects moonshot for Kimi model ids reached through gateways", () => {
		const relay = { ...localModel, id: "kimi-k3", name: "Kimi K3", provider: "relay" };
		expect(getCompat(relay).toolSchemaFlavor).toBe("moonshot");
		const openrouter = getBuiltinModel("openrouter", "moonshotai/kimi-k2.6");
		expect(getCompat(openrouter).toolSchemaFlavor).toBe("moonshot");
		// The same gateway stays standard for ids that only contain the letters.
		const lookalike = { ...localModel, id: "skimi-v1", name: "Not Kimi" };
		expect(getCompat(lookalike).toolSchemaFlavor).toBeUndefined();
		expect(getCompat(localModel).toolSchemaFlavor).toBeUndefined();
	});

	it("sends repaired tool parameters to a moonshot model", async () => {
		const model = getBuiltinModel("moonshotai", "kimi-k2.6");
		const parameters = await capturedToolParameters(model, tool);
		expect(parameters.type).toBe("object");
		const branch = (parameters.anyOf as Array<Record<string, unknown>>)[0];
		const items = ((branch.properties as Record<string, unknown>).queries as Record<string, unknown>).items as Record<
			string,
			unknown
		>;
		const rows = items.anyOf as Array<Record<string, Record<string, unknown>>>;
		expect(rows[0]?.properties?.ecosystem).toMatchObject({ const: "npm", type: "string" });
	});

	it("sends standard parameters to a non-moonshot model", async () => {
		const model = localModel;
		const parameters = await capturedToolParameters(model, tool);
		const branch = (parameters.anyOf as Array<Record<string, unknown>>)[0];
		const items = ((branch.properties as Record<string, unknown>).queries as Record<string, unknown>).items as Record<
			string,
			unknown
		>;
		const rows = items.anyOf as Array<Record<string, Record<string, unknown>>>;
		// Standard endpoints take the schema as authored: the type-less const stays.
		expect(rows[0]?.properties?.ecosystem).toEqual({ const: "npm" });
	});

	it("sends repaired tool parameters to a Kimi model behind a gateway", async () => {
		const model = { ...localModel, id: "kimi-k3", name: "Kimi K3", provider: "relay" };
		const parameters = await capturedToolParameters(model, tool);
		expect(parameters.type).toBe("object");
		const branch = (parameters.anyOf as Array<Record<string, unknown>>)[0];
		const items = ((branch.properties as Record<string, unknown>).queries as Record<string, unknown>).items as Record<
			string,
			unknown
		>;
		const rows = items.anyOf as Array<Record<string, Record<string, unknown>>>;
		expect(rows[0]?.properties?.ecosystem).toMatchObject({ const: "npm", type: "string" });
	});

	it("allows model.compat.toolSchemaFlavor 'standard' to opt out of auto-detection", () => {
		const moonshotModel = getBuiltinModel("moonshotai", "kimi-k2.6");
		expect(getCompat(moonshotModel).toolSchemaFlavor).toBe("moonshot");
		const optedOut = { ...moonshotModel, compat: { toolSchemaFlavor: "standard" as const } };
		expect(getCompat(optedOut).toolSchemaFlavor).toBe("standard");
	});

	it("detects moonshot for kimi-coding provider and api.kimi.com endpoints", () => {
		const coding = { ...localModel, provider: "kimi-coding" as const };
		expect(getCompat(coding).toolSchemaFlavor).toBe("moonshot");
		const kimiEndpoint = { ...localModel, baseUrl: "https://api.kimi.com/v1" };
		expect(getCompat(kimiEndpoint).toolSchemaFlavor).toBe("moonshot");
	});
});
