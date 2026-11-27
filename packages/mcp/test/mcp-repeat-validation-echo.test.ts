import { validateToolArguments } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const schema = {
	type: "object",
	properties: {
		queries: {
			type: "array",
			maxItems: 2,
			items: { type: "object", properties: { path: { type: "string" }, reasoning: { type: "string" } } },
		},
	},
	required: ["queries"],
	additionalProperties: false,
};

const define = (inputSchema: Record<string, unknown> = schema) =>
	createMcpToolDefinition({
		server: "third",
		tool: { name: "find", inputSchema },
		name: "mcp__third__find",
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => {
			throw new Error("not called");
		},
	});

const message = (tool: ReturnType<typeof define>, args: Record<string, unknown>): string => {
	try {
		validateToolArguments(tool as never, { type: "toolCall", id: "c", name: tool.name, arguments: args } as never);
	} catch (error) {
		return (error as Error).message;
	}
	return "";
};

describe("repeated identical MCP validation failure", () => {
	it("hints the call shape the first time and echoes the corrected call the second", () => {
		const tool = define();
		const args = { reasoning: "why", queries: [{ path: "a" }] };
		const first = message(tool, args);
		expect(first).toContain("requires");
		expect(first).not.toContain("failed identically");
		expect(message(tool, args)).toContain('{"queries":[{"reasoning":"why","path":"a"}]}');
	});

	it("splits an over-long batch and preserves each query", () => {
		const tool = define();
		const args = { queries: [{ path: "a" }, { path: "b" }, { path: "c" }] };
		message(tool, args);
		const second = message(tool, args);
		expect(second).toContain("these 2 calls");
		expect(second).toContain('{"queries":[{"path":"a"},{"path":"b"}]}');
		expect(second).toContain('{"queries":[{"path":"c"}]}');
	});

	it("does not echo for a different failure after the first", () => {
		const tool = define();
		message(tool, { reason: "a", queries: [] });
		expect(message(tool, { reasoning: "b", queries: [] })).not.toContain("failed identically");
	});
});

describe("schema-derived repeated-call examples", () => {
	const options = { type: "object", properties: { depth: { type: "integer" } }, additionalProperties: false };
	const object = (properties: Record<string, unknown>) => ({ type: "object", properties, additionalProperties: false });
	const repeated = (inputSchema: Record<string, unknown>, args: Record<string, unknown>) => {
		const tool = define(inputSchema);
		message(tool, args);
		return message(tool, args);
	};

	it("moves a field with the original value into a single declared object destination", () => {
		const args = { options: {}, depth: 3 };
		expect(repeated(object({ options }), args)).toContain('{"options":{"depth":3}}');
		expect(args).toEqual({ options: {}, depth: 3 });
	});

	it("withholds a call that would drop, overwrite, broadcast, guess a destination or fail validation", () => {
		const cases = [
			[object({ options }), { options: {}, depthValue: 3 }],
			[object({ options }), { options: { depth: 0 }, depth: 3 }],
			[object({ options: { type: "array", items: options } }), { options: [{}, {}], depth: 3 }],
			[object({ options, fallback: options }), { options: {}, depth: 3 }],
			[object({ options }), { options: {}, depth: "3" }],
			[schema, { invented: 3, queries: [{}, {}, {}] }],
		] as const;
		for (const [contract, args] of cases) expect(repeated(contract, args)).not.toContain("failed identically");
	});

	it("withholds a corrected call beyond the echo budget", () => {
		const large = { reasoning: "x".repeat(1500), queries: [{ path: "a" }] };
		expect(repeated(schema, large)).not.toContain("failed identically");
	});
});
