import { validateToolArguments } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const define = (inputSchema: Record<string, unknown>, sent: Record<string, unknown>[] = []) =>
	createMcpToolDefinition({
		server: "octocode",
		tool: { name: "localFetch", inputSchema },
		name: "mcp__octocode__localFetch",
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => ({
			callTool: async (_name, args) => {
				sent.push(args);
				return { content: [{ type: "text", text: "OK" }] };
			},
		}),
	});

const validate = (tool: ReturnType<typeof define>, args: Record<string, unknown>) =>
	validateToolArguments(tool as never, { type: "toolCall", id: "c", name: tool.name, arguments: args as never });

/** The octocode shape: `queries` items declare `reasoning` (not `reason`), `responseChars` and `cursor` sit at the root. */
const ITEM = {
	type: "object",
	properties: { path: { type: "string" }, reasoning: { type: "string" } },
	required: ["path"],
	additionalProperties: false,
};
const OCTOCODE = {
	type: "object",
	properties: {
		queries: { type: "array", maxItems: 5, items: { $ref: "#/$defs/query" } },
		responseChars: { type: "integer" },
		cursor: { type: "string" },
	},
	additionalProperties: false,
	$defs: { query: ITEM },
};

// The server owns its input (by design): nothing is added, dropped, moved, converted or parsed, and a
// call its schema rejects fails instead of being repaired.
describe("MCP tool arguments", () => {
	it("declares no argument preparation and opts out of validator coercion", () => {
		const tool = define(OCTOCODE);
		expect(tool.prepareArguments).toBeUndefined();
		expect(tool.coerceArguments).toBe(false);
	});

	it("sends valid arguments to the server exactly as the model wrote them", async () => {
		const sent: Record<string, unknown>[] = [];
		const tool = define(OCTOCODE, sent);
		const args = { queries: [{ path: "a", reasoning: "why" }, { path: "b" }], responseChars: 4000 };
		const validated = validate(tool, args);
		expect(validated).toEqual(args);
		await tool.execute("c", validated, undefined, undefined, {} as never);
		expect(sent).toEqual([args]);
	});

	it("keeps a reason the server declares", () => {
		const tool = define({ type: "object", properties: { reason: { type: "string" } }, additionalProperties: false });
		expect(validate(tool, { reason: "r" })).toEqual({ reason: "r" });
	});

	it("rejects the shapes it used to rewrite, instead of repairing them", () => {
		const tool = define(OCTOCODE);
		for (const args of [
			{ queries: [{ path: "a" }], reason: "copied from a native tool" },
			{ queries: [{ path: "a", reason: "r" }] },
			{ queries: [{ path: "a", responseChars: 4000 }] },
			{ queries: '[{"path":"a"}]' },
			{ queries: [{ path: "a" }], responseChars: "4000" },
		]) {
			expect(() => validate(tool, args)).toThrow(/mcp__octocode__localFetch/);
		}
	});
});
