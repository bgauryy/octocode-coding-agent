import { validateToolArguments } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const batchSchema = (maxItems?: number) => ({
	type: "object",
	properties: {
		queries: { type: "array", items: { type: "object", properties: { path: { type: "string" } } }, maxItems },
	},
	required: ["queries"],
});

const define = (inputSchema: Record<string, unknown>, compact?: { signature: () => string | undefined }) =>
	createMcpToolDefinition({
		server: "octocode",
		tool: { name: "localFetch", inputSchema },
		name: "mcp__octocode__localFetch",
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => {
			throw new Error("not called");
		},
		...(compact ? { compact } : {}),
	});

const validate = (tool: ReturnType<typeof define>, count: number) =>
	validateToolArguments(
		tool as never,
		{
			type: "toolCall",
			id: "c",
			name: tool.name,
			arguments: { queries: Array.from({ length: count }, (_, i) => ({ path: `f${i}.ts` })) },
		} as never,
	);

// localFetch refused 6-14 queries 30 times: the server's cap message named no way forward.
describe("MCP queries batch cap", () => {
	const next = /queries holds at most 5; split into calls of 5 or fewer, run them in the same turn\./;

	it("tells a model that sent too many queries to split the batch", () => {
		expect(() => validate(define(batchSchema(5)), 7)).toThrow(next);
	});

	it("adds the cap beside a compact tool's typed signature", () => {
		const tool = define(batchSchema(5), { signature: () => "declare function localFetch(q: Q): R;" });
		expect(() => validate(tool, 6)).toThrow(
			/split into calls of 5 or fewer[\s\S]*Expected signature \(TypeScript\):\ndeclare function localFetch/,
		);
	});

	it("leaves the cap out of a failure that does not concern queries", () => {
		const tool = define({ ...batchSchema(5), additionalProperties: false });
		const message = (args: Record<string, unknown>) => {
			try {
				validateToolArguments(tool as never, { type: "toolCall", id: "c", name: tool.name, arguments: args } as never);
			} catch (error) {
				return (error as Error).message;
			}
			throw new Error("expected a validation failure");
		};
		expect(message({ queries: [{ path: "a" }], cursor: "next" })).not.toContain("queries holds at most");
		expect(message({ queries: [{ path: "a" }], reason: "why" })).not.toContain("queries holds at most");
		expect(message({ queries: Array.from({ length: 7 }, () => ({ path: "a" })) })).toContain("queries holds at most 5");
	});

	it("keeps the deferred schema or compact signature beside the nested field hint", () => {
		const inputSchema = {
			...batchSchema(),
			properties: {
				queries: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: { path: { type: "string" } },
					},
				},
			},
		};
		for (const compact of [
			{ signature: () => "declare function read(path: string): unknown;" },
			{ signature: () => undefined, whole: true },
		]) {
			const tool = define(inputSchema, compact);
			const call = () =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "c",
					name: tool.name,
					arguments: { queries: [{ pathValue: "a" }] },
				});
			expect(call).toThrow("Declared fields at /queries/0: path.");
			expect(call).toThrow(compact.signature() ?? JSON.stringify(inputSchema));
		}
	});

	it("accepts a batch within the cap and adds no cap hint where the server declares no cap", () => {
		expect(validate(define(batchSchema(5)), 5)).toMatchObject({ queries: expect.any(Array) });
		const uncapped = define(batchSchema());
		expect(uncapped.validationHint?.({ envelope: false, properties: [] })).toBeUndefined();
		expect(validate(uncapped, 9)).toMatchObject({ queries: expect.any(Array) });
		// A compact tool without a cap keeps only its signature.
		const compact = define(batchSchema(), { signature: () => "declare function t(): void;" });
		expect(compact.validationHint?.({ envelope: false, properties: [] })).toBe(
			"Expected signature (TypeScript):\ndeclare function t(): void;",
		);
	});
});

// The Octocode server's root is `anyOf` [queries (+ responseChars) | cursor], each branch closed.
const unionSchema = {
	type: "object",
	anyOf: [
		{
			type: "object",
			properties: {
				queries: { type: "array", items: { type: "object", properties: { path: { type: "string" } } }, maxItems: 5 },
				responseChars: { type: "integer" },
			},
			required: ["queries"],
			additionalProperties: false,
		},
		{ type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"], additionalProperties: false },
	],
};

describe("MCP envelope errors", () => {
	const signature = { signature: () => "declare function localFetch(q: Q): R;" };
	const fail = (args: Record<string, unknown>) => {
		const tool = define(unionSchema, signature);
		try {
			validateToolArguments(tool as never, { type: "toolCall", id: "c", name: tool.name, arguments: args } as never);
		} catch (error) {
			return (error as Error).message;
		}
		throw new Error("expected a validation failure");
	};

	it("names required fields for foreign root properties, without the signature", () => {
		const message = fail({ queries: [{ path: "a" }], type: "x", timeout: 5, background: false, verify: false });
		expect(message).toContain(
			'mcp__octocode__localFetch requires {"queries":[...]} or {"cursor":"..."} at the top level.',
		);
		expect(message).toContain("Other declared fields: responseChars; follow the server's schema for each form.");
		expect(message).not.toContain("Expected signature");
		expect(message).not.toContain("declare function");
	});

	it("names the shape when the root has neither queries nor cursor", () => {
		expect(fail({ path: "a" })).toContain('requires {"queries":[...]} or {"cursor":"..."}');
	});

	it("keeps the signature and the batch cap for a failure inside queries", () => {
		const nested = fail({ queries: [{ path: { a: 1 } }] });
		expect(nested).toContain("Expected signature (TypeScript):");
		expect(nested).not.toContain("at the top level");
		const long = fail({ queries: Array.from({ length: 6 }, () => ({ path: "a" })) });
		expect(long).toContain("queries holds at most 5; split into calls of 5 or fewer, run them in the same turn.");
	});
});
