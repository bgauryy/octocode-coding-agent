import { octocodeToolDefinition } from "../../../mcp/test/mcp-preset-tool-fixture.ts";
import { runToolCall } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { fakeCtx } from "./fake-pi.ts";

const inputSchema = {
	type: "object" as const,
	additionalProperties: false,
	properties: {
		queries: {
			type: "array",
			maxItems: 5,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					length: { type: "integer" },
					fullContent: { type: "boolean" },
					cursor: { type: "string" },
				},
			},
		},
	},
};

function setup(schema = inputSchema) {
	const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
		content: [{ type: "text" as const, text: "ok" }],
	}));
	const beforeToolCall = vi.fn(async (_event: { args: unknown }) => undefined);
	const definition = octocodeToolDefinition(
		{ name: "localFetch", inputSchema: schema },
		{ namespace: { name: "mcp__octocode" }, call },
	);
	const tool = wrapToolDefinition(definition, () => fakeCtx({ cwd: "/work" }) as never);
	const run = (args: Record<string, any>) =>
		runToolCall(
			{ type: "toolCall", id: "call", name: tool.name, arguments: args },
			{
				tools: [tool],
				assistantMessage: fauxAssistantMessage("Continue"),
				context: { messages: [], tools: [tool] },
				beforeToolCall,
			},
		);
	return { run, call, beforeToolCall };
}

describe("Octocode argument preflight", () => {
	it.each([1, 2])(
		"decodes a query envelope encoded %i time(s) and coerces typed scalars before gates",
		async (depth) => {
			const f = setup();
			let queries = JSON.stringify([{ path: "file.ts", length: "300", fullContent: "true" }]);
			if (depth === 2) queries = JSON.stringify(queries);
			const args = { queries };
			expect((await f.run(args)).isError).toBe(false);
			const expected = { queries: [{ path: "file.ts", length: 300, fullContent: true }] };
			expect(f.beforeToolCall.mock.calls[0][0].args).toEqual(expected);
			expect(f.call).toHaveBeenCalledOnce();
			expect(f.call.mock.calls[0][1]).toEqual(expected);
			expect(args).toEqual({ queries });
		},
	);

	it("decodes queries chosen through a spec-valid root anyOf (queries or cursor) before gates", async () => {
		const rootAnyOf = {
			type: "object" as const,
			anyOf: [
				{ properties: { queries: inputSchema.properties.queries }, additionalProperties: false, required: ["queries"] },
				{ properties: { cursor: { type: "string" } }, additionalProperties: false, required: ["cursor"] },
			],
		};
		const f = setup(rootAnyOf as never);
		expect((await f.run({ queries: JSON.stringify([{ path: "file.ts", length: "5" }]) })).isError).toBe(false);
		expect(f.call.mock.calls[0][1]).toEqual({ queries: [{ path: "file.ts", length: 5 }] });
		expect((await f.run({ cursor: "next" })).isError).toBe(false);
		expect(f.call.mock.calls[1][1]).toEqual({ cursor: "next" });
	});

	it.each([
		{ queries: "not json" },
		{ queries: JSON.stringify({ path: "wrong-container" }) },
		{ queries: [{}, {}], cursor: "ambiguous" },
		{ queries: [{ cursor: "existing" }], cursor: "conflict" },
	])("rejects arguments the schema does not allow before gates: %j", async (args) => {
		const f = setup();
		const result = await f.run(args);
		expect(result.isError).toBe(true);
		expect(result.result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("Validation failed") }),
		]);
		expect(f.call).not.toHaveBeenCalled();
		expect(f.beforeToolCall).not.toHaveBeenCalled();
	});

	it("validates every decoded field and the batch cap before reaching the server", async () => {
		for (const queries of [
			[{ length: "not a number" }],
			[{ unknownField: true }],
			[null],
			Array.from({ length: 6 }, () => ({})),
		]) {
			const f = setup();
			expect((await f.run({ queries: JSON.stringify(queries) })).isError).toBe(true);
			expect(f.call).not.toHaveBeenCalled();
		}
	});

	it("rejects unknown envelope fields after repairing queries", async () => {
		const f = setup();
		expect((await f.run({ queries: "[{}]", unknownField: true })).isError).toBe(true);
		expect(f.call).not.toHaveBeenCalled();
	});
});
