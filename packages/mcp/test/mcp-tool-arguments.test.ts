import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const define = (inputSchema: Record<string, unknown>) =>
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
	});

// Every native tool requires `reason`, so models add it to MCP calls too; servers that forbid extra keys rejected
// those calls ("reason: schema is false") 4 times in one session.
describe("MCP tool arguments", () => {
	it("drops a top-level reason the server schema does not declare, before validation", () => {
		const tool = define({ type: "object", properties: { path: { type: "string" } }, additionalProperties: false });
		expect(tool.prepareArguments?.({ path: "a.ts", reason: "read it" })).toEqual({ path: "a.ts" });
	});

	it("keeps reason when the server declares it, and leaves other arguments alone", () => {
		const declared = define({
			type: "object",
			properties: { reason: { type: "string" }, reasoning: { type: "string" } },
		});
		expect(declared.prepareArguments).toBeUndefined();
		const keeps = define({ type: "object", properties: { reason: { type: "string" } } });
		expect(keeps.prepareArguments?.({ reason: "r", reasoning: "x" })).toEqual({ reason: "r" });
		const strict = define({ type: "object", properties: { path: { type: "string" } } });
		const args = { path: "a.ts" };
		expect(strict.prepareArguments?.(args)).toBe(args);
		expect(strict.prepareArguments?.("raw")).toBe("raw");
	});
});

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
/** A tool whose cursor form takes the cursor alone (structureSearch, clasify). */
const CURSOR_ALONE = {
	anyOf: [
		{
			type: "object",
			properties: { queries: { type: "array", items: ITEM }, responseChars: { type: "integer" } },
			required: ["queries"],
			additionalProperties: false,
		},
		{ type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"], additionalProperties: false },
	],
};

describe("MCP argument normalization", () => {
	it("drops an undeclared reason inside queries items and keeps the declared reasoning", () => {
		const tool = define(OCTOCODE);
		expect(
			tool.prepareArguments?.({ queries: [{ path: "a", reason: "r", reasoning: "why" }, { path: "b" }], reason: "x" }),
		).toEqual({ queries: [{ path: "a", reasoning: "why" }, { path: "b" }] });
	});

	it("drops reasoning in a query only when the item schema does not declare it", () => {
		const tool = define({
			type: "object",
			properties: { queries: { type: "array", items: { type: "object", properties: { path: { type: "string" } } } } },
		});
		expect(tool.prepareArguments?.({ queries: [{ path: "a", reasoning: "why", reason: "r" }] })).toEqual({
			queries: [{ path: "a" }],
		});
	});

	it("moves responseChars from a query to the root when only the root declares it", () => {
		const tool = define(OCTOCODE);
		expect(
			tool.prepareArguments?.({
				queries: [
					{ path: "a", responseChars: 4000 },
					{ path: "b", responseChars: 9000 },
				],
			}),
		).toEqual({ queries: [{ path: "a" }, { path: "b" }], responseChars: 9000 });
		// A root value the model gave wins.
		expect(tool.prepareArguments?.({ queries: [{ path: "a", responseChars: 4000 }], responseChars: 100 })).toEqual({
			queries: [{ path: "a" }],
			responseChars: 100,
		});
		// An item that declares responseChars keeps it.
		const own = define({
			type: "object",
			properties: {
				queries: { type: "array", items: { type: "object", properties: { responseChars: { type: "integer" } } } },
				responseChars: { type: "integer" },
			},
		});
		const args = { queries: [{ responseChars: 1 }] };
		expect(own.prepareArguments?.(args)).toBe(args);
	});

	it("drops responseChars beside a cursor only when the cursor form takes the cursor alone", () => {
		expect(define(CURSOR_ALONE).prepareArguments?.({ cursor: "c1", responseChars: 4000 })).toEqual({ cursor: "c1" });
		const both = { cursor: "c1", responseChars: 4000 };
		expect(define(OCTOCODE).prepareArguments?.(both)).toBe(both);
	});

	it("parses queries sent as a JSON string of an array, and leaves any other string alone", () => {
		const tool = define(OCTOCODE);
		expect(tool.prepareArguments?.({ queries: '[{"path":"a","reason":"r"}]' })).toEqual({ queries: [{ path: "a" }] });
		const bad = { queries: "not json" };
		expect(tool.prepareArguments?.(bad)).toBe(bad);
		const object = { queries: '{"path":"a"}' };
		expect(tool.prepareArguments?.(object)).toBe(object);
	});
});
