import "../mcp-host.ts";
import { octocodeToolDefinition } from "../../../mcp/test/mcp-preset-tool-fixture.ts";
import { runToolCall } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { fakeCtx } from "./fake-host.ts";

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

// The server owns its input (user decision, 2026-11-05): gates and the server see the arguments as the model sent
// them, and a shape the schema rejects (a JSON-string `queries`, a number as text) fails instead of being repaired.
describe("Octocode argument preflight", () => {
	it("passes valid arguments to the gates and the server exactly as sent", async () => {
		const f = setup();
		const args = { queries: [{ path: "file.ts", length: 300, fullContent: true }] };
		expect((await f.run(args)).isError).toBe(false);
		expect(f.beforeToolCall.mock.calls[0][0].args).toEqual(args);
		expect(f.call).toHaveBeenCalledOnce();
		expect(f.call.mock.calls[0][1]).toEqual(args);
	});

	it.each([1, 2])("rejects a query envelope encoded %i time(s) as a JSON string, before gates", async (depth) => {
		const f = setup();
		let queries = JSON.stringify([{ path: "file.ts", length: 300 }]);
		if (depth === 2) queries = JSON.stringify(queries);
		expect((await f.run({ queries })).isError).toBe(true);
		expect(f.beforeToolCall).not.toHaveBeenCalled();
		expect(f.call).not.toHaveBeenCalled();
	});

	it("rejects typed scalars sent as text instead of converting them", async () => {
		const f = setup();
		expect((await f.run({ queries: [{ path: "file.ts", length: "300", fullContent: "true" }] })).isError).toBe(true);
		expect(f.call).not.toHaveBeenCalled();
	});

	it("accepts either form of a spec-valid root anyOf (queries or cursor) unchanged", async () => {
		const rootAnyOf = {
			type: "object" as const,
			anyOf: [
				{ properties: { queries: inputSchema.properties.queries }, additionalProperties: false, required: ["queries"] },
				{ properties: { cursor: { type: "string" } }, additionalProperties: false, required: ["cursor"] },
			],
		};
		const f = setup(rootAnyOf as never);
		expect((await f.run({ queries: [{ path: "file.ts", length: 5 }] })).isError).toBe(false);
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

	it("validates every field and the batch cap before reaching the server", async () => {
		for (const queries of [
			[{ length: "not a number" }],
			[{ unknownField: true }],
			[null],
			Array.from({ length: 6 }, () => ({})),
		]) {
			const f = setup();
			expect((await f.run({ queries })).isError).toBe(true);
			expect(f.call).not.toHaveBeenCalled();
		}
	});

	it("rejects unknown envelope fields", async () => {
		const f = setup();
		expect((await f.run({ queries: [{}], unknownField: true })).isError).toBe(true);
		expect(f.call).not.toHaveBeenCalled();
	});
});
