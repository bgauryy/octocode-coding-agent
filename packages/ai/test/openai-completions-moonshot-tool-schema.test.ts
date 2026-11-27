import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";
import { describe, expect, it, vi } from "vitest";
import { getCompat } from "../src/api/openai-completions/compat.ts";
import { sanitizeMoonshotToolParameters } from "../src/api/openai-completions/tool-schema-flavor.ts";
import { streamSimple } from "../src/compat.ts";
import { validateToolArguments } from "../src/utils/validation.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model, Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

mockCompletionsFetch((params: unknown) => {
	mockState.lastParams = params;
	const stream = {
		async *[Symbol.asyncIterator]() {
			yield { choices: [{ delta: {}, finish_reason: "stop" }] };
		},
	};
	return completionsResponse(stream);
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
			ecosystem: { enum: ["npm"], type: "string" },
			level: { enum: ["patch", "minor"], type: "string" },
			anything: { type: "string" },
			numbered: { enum: [3], type: "integer" },
			flag: { const: true, type: "boolean" },
		});
	});

	it("keeps every legal mixed enum value callable without string coercion", () => {
		const parameters = {
			type: "object",
			required: ["mode"],
			properties: {
				mode: { enum: ["auto", 1, 2.5, true, null] },
			},
		};
		const tool: Tool = { name: "configure", description: "", parameters, coerceArguments: false };
		const wire = { ...tool, parameters: sanitizeMoonshotToolParameters(parameters) };
		const accepts = (candidate: Tool, mode: string | number | boolean | null) =>
			validateToolArguments(candidate, { type: "toolCall", id: "call", name: "configure", arguments: { mode } });
		for (const mode of parameters.properties.mode.enum) {
			expect(() => accepts(tool, mode)).not.toThrow();
			expect(() => accepts(wire, mode)).not.toThrow();
		}
		for (const mode of ["other", 3]) expect(() => accepts(wire, mode)).toThrow();
		expect(() => accepts(tool, false)).toThrow();
	});

	it("describes a literal boolean and honors explicit types when projecting a mixed enum", () => {
		const source: Tool = {
			name: "open",
			description: "",
			parameters: {
				type: "object",
				properties: {
					acknowledge: { type: "boolean", enum: [true], description: "Confirm the action." },
					mode: { type: ["integer", "string"], enum: [1, 2.5, "auto", true] },
				},
			},
			coerceArguments: false,
		};
		const wire = sanitizeMoonshotToolParameters(source.parameters);
		expect(wire.properties).toMatchObject({
			acknowledge: { type: "boolean", description: "Confirm the action. Allowed value: true." },
			mode: {
				anyOf: [
					{ type: "integer", enum: [1] },
					{ type: "string", enum: ["auto"] },
				],
			},
		});
		expect(wire.properties).not.toHaveProperty("acknowledge.enum");
		expect(() =>
			validateToolArguments(source, { type: "toolCall", id: "1", name: "open", arguments: { acknowledge: false } }),
		).toThrow();
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

	it("projects root alternatives into named fields and keeps distinct nested query shapes", () => {
		const sanitized = sanitizeMoonshotToolParameters(KIMI_REJECTED_SCHEMA);
		expect(sanitized.type).toBe("object");
		expect(sanitized.anyOf).toBeUndefined();
		const properties = sanitized.properties as Record<string, Record<string, unknown>>;
		expect(properties.cursor).toEqual({ type: "string", minLength: 1 });
		const items = properties.queries.items as Record<string, unknown>;
		expect(items.type).toBeUndefined();
		const rows = items.anyOf as Array<Record<string, Record<string, unknown>>>;
		expect(rows[0]?.properties?.ecosystem).toMatchObject({ enum: ["npm"], type: "string" });
		expect(rows[0]?.properties?.operation).toMatchObject({ enum: ["resolve"], type: "string" });
		expect(rows[0]?.properties?.registryUrl).toEqual({ type: "string" });
		expect(rows[1]?.properties?.ecosystem).toMatchObject({ enum: ["crates", "maven"], type: "string" });
	});

	it("projects nested object alternatives from an MCP tool while the original validation keeps exclusive fields", () => {
		const item = {
			type: "object",
			properties: { name: { type: "string" }, text: { type: "string" }, uri: { type: "string" } },
			required: ["name"],
			additionalProperties: false,
			oneOf: [{ required: ["text"] }, { required: ["uri"] }],
		};
		const parameters = { type: "object", properties: { batch: { type: "array", items: item } } };
		const source = { name: "publish", description: "Publish", parameters };
		const wire = sanitizeMoonshotToolParameters(parameters);
		expect(wire.properties).toEqual({
			batch: {
				type: "array",
				items: { type: "object", required: ["name"], properties: item.properties, additionalProperties: false },
			},
		});
		const call = (row: Record<string, string>) =>
			validateToolArguments(source, {
				type: "toolCall",
				id: "publish",
				name: "publish",
				arguments: { batch: [row] },
			});
		expect(() => call({ name: "a", uri: "file:///a" })).not.toThrow();
		expect(() => call({ name: "a", uri: "file:///a", text: "copy" })).toThrow();
	});

	it("repairs $defs subschemas but leaves $ref nodes alone", () => {
		const sanitized = sanitizeMoonshotToolParameters({
			type: "object",
			$defs: { name: { const: "npm" } },
			properties: { ecosystem: { $ref: "#/$defs/name" } },
		});
		expect(sanitized.$defs).toEqual({ name: { enum: ["npm"], type: "string" } });
		expect((sanitized.properties as Record<string, unknown>).ecosystem).toEqual({ $ref: "#/$defs/name" });
	});

	it("inlines a $ref under propertyNames, which Moonshot rejects, and drops one it cannot resolve", () => {
		// The shape of the Octocode MCP `clasify` assets field: a record whose key names come from shared definitions.
		const sanitized = sanitizeMoonshotToolParameters({
			type: "object",
			$defs: { key: { $ref: "#/definitions/name" } },
			definitions: { name: { pattern: "^[a-z]+$" } },
			properties: {
				assets: { type: "object", propertyNames: { $ref: "#/$defs/key", description: "Asset name" } },
				other: { type: "object", propertyNames: { $ref: "#/$defs/missing" } },
				loop: { type: "object", propertyNames: { $ref: "#/$defs/self" } },
			},
		});
		const properties = sanitized.properties as Record<string, Record<string, unknown>>;
		expect(properties.assets.propertyNames).toEqual({
			pattern: "^[a-z]+$",
			description: "Asset name",
			type: "string",
		});
		expect(properties.other).toEqual({ type: "object" });
		expect(properties.loop).toEqual({ type: "object" });
		expect(JSON.stringify(sanitized)).not.toMatch(/"propertyNames":\{"\$ref"/);
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
		const properties = parameters.properties as Record<string, Record<string, unknown>>;
		const items = properties.queries.items as Record<string, unknown>;
		const rows = items.anyOf as Array<Record<string, Record<string, unknown>>>;
		expect(rows[0]?.properties?.ecosystem).toMatchObject({ enum: ["npm"], type: "string" });
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
		const properties = parameters.properties as Record<string, Record<string, unknown>>;
		const items = properties.queries.items as Record<string, unknown>;
		const rows = items.anyOf as Array<Record<string, Record<string, unknown>>>;
		expect(rows[0]?.properties?.ecosystem).toMatchObject({ enum: ["npm"], type: "string" });
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
