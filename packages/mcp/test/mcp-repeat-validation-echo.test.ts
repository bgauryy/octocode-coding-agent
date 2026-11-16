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

const define = () =>
	createMcpToolDefinition({
		server: "third",
		tool: { name: "find", inputSchema: schema },
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

	it("drops an offending root field no query declares, and splits an over-long batch", () => {
		const tool = define();
		const args = { reason: "why", queries: [{ path: "a" }, { path: "b" }, { path: "c" }] };
		message(tool, args);
		const second = message(tool, args);
		expect(second).toContain("these 2 calls");
		expect(second).toContain('{"queries":[{"path":"a"},{"path":"b"}]}');
		expect(second).toContain('{"queries":[{"path":"c"}]}');
		expect(second.split("failed identically")[1]).not.toContain('"reason"');
	});

	it("does not echo for a different failure after the first", () => {
		const tool = define();
		message(tool, { reason: "a", queries: [] });
		expect(message(tool, { reasoning: "b", queries: [] })).not.toContain("failed identically");
	});
});
