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

// The server owns its input (by design): nothing is added, moved, converted or parsed, and a call its schema
// rejects fails instead of being repaired. The one field dropped is a top-level string `reason` that a closed schema
// neither declares nor accepts, carried over from native tools.
describe("MCP tool arguments", () => {
	it("prepares only by dropping a leaked top-level reason and opts out of validator coercion", () => {
		const tool = define(OCTOCODE);
		const args = { queries: [{ path: "a", reasoning: "why" }], responseChars: 4000 };
		expect(tool.prepareArguments?.({ ...args, reason: "copied from a native tool" })).toEqual(args);
		expect(tool.prepareArguments?.(args)).toBe(args);
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

	it("refuses invented names on each attempt, identifies sibling fields and forwards only the valid control", async () => {
		const sent: Record<string, unknown>[] = [];
		const tool = define(
			{
				...OCTOCODE,
				$defs: {
					query: {
						...ITEM,
						properties: {
							...ITEM.properties,
							maxDepth: { type: "integer" },
							testCode: { enum: ["include", "exclude"] },
						},
					},
				},
			},
			sent,
		);
		const run = async (args: Record<string, unknown>) =>
			tool.execute("c", validate(tool, args), undefined, undefined, {} as never);
		for (const key of ["maxDepthValue", "testCodeinclude"]) {
			const args = { queries: [{ path: "a", [key]: 3 }] };
			for (let attempt = 0; attempt < 2; attempt++) {
				const refusal = await run(args).then(
					() => {
						throw new Error("expected refusal");
					},
					(error: Error) => error.message,
				);
				expect(refusal).toContain(`queries.0: unexpected property ${key}`);
				expect(refusal).toContain("Declared fields at /queries/0: path, reasoning, maxDepth, testCode.");
				expect(refusal).not.toMatch(/Send this call|split into calls/);
			}
		}
		expect(sent).toEqual([]);
		const valid = { queries: [{ path: "a", maxDepth: 3, testCode: "include" }] };
		await run(valid);
		expect(sent).toEqual([valid]);
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

it("reports the selected branch for each array element, including a referenced item union", () => {
	const tool = define({
		...OCTOCODE,
		$defs: {
			query: {
				oneOf: ["file", "tree"].map((op) => ({
					type: "object",
					properties: { op: { const: op }, [op]: { type: "string" } },
					required: ["op"],
					unevaluatedProperties: false,
				})),
			},
		},
	});
	const args = {
		queries: [
			{ op: "file", fileValue: "a" },
			{ op: "tree", treeValue: "b" },
		],
	};
	const failure = () => validate(tool, args);
	expect(failure).toThrow(/queries\.0: unexpected property fileValue/);
	expect(failure).toThrow(/queries\.1: unexpected property treeValue/);
	expect(failure).toThrow(/Declared fields at \/queries\/0: op, file\./);
	expect(failure).toThrow(/Declared fields at \/queries\/1: op, tree\./);
});

it("withholds sibling names from an incomplete union at the validator's error limit", () => {
	const tool = define({
		...OCTOCODE,
		$defs: {
			query: {
				oneOf: ["file", "tree"].map((op) => ({
					type: "object",
					properties: { op: { const: op }, [op]: { type: "string" } },
					required: ["op"],
					additionalProperties: false,
				})),
			},
		},
	});
	const run = () =>
		validate(tool, {
			queries: [
				{ op: "file", a: 1 },
				{ op: "tree", b: 1 },
			],
		});
	expect(run).toThrow(/Declared fields at \/queries\/0: op, file\./);
	expect(run).toThrow(/Load the full schema/);
	expect(run).not.toThrow(/Declared fields at \/queries\/1: op, file\./);
});
