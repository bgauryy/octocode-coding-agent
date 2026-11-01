import { describe, expect, it } from "vitest";
import {
	catalogHash,
	checkFidelity,
	type CompactServerInput,
	functionNames,
	renderServer,
	schemaToTs,
	selectTools,
	toolBlock,
} from "../src/compact/index.ts";
import { McpPresentation } from "../src/presentation/index.ts";
import { assignMcpToolNames } from "../src/tool-names.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

const render = (schema: unknown) => {
	const { type, aliases } = schemaToTs(schema as never, { scope: "X_" });
	return [...aliases, type].join("\n");
};
const server = (tools: CompactServerInput["tools"], extra: Partial<CompactServerInput> = {}): CompactServerInput => ({
	server: "s",
	tools,
	...extra,
});

describe("schemaToTs keeps what the schema says", () => {
	it("resolves JSON-pointer references to the root and to properties", () => {
		const text = render({
			type: "object",
			properties: {
				name: { type: "string" },
				alias: { $ref: "#/properties/name" },
				children: { type: "array", items: { $ref: "#" } },
			},
		});
		expect(text).not.toContain("unresolved");
		expect(text).toContain("alias?: string;");
		expect(text).toContain("type X_$root = {");
		expect(text).toContain("children?: X_$root[];");
	});

	it("states required-only alternatives instead of dropping them", () => {
		expect(
			render({
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" } },
				anyOf: [{ required: ["a"] }, { required: ["b"] }],
			}),
		).toMatch(/b\?: string;\n} \/\* at least one of: a required \| b required \*\/$/);
		expect(render({ type: "object", oneOf: [{ required: ["x", "y"] }, { required: ["z"] }] })).toContain(
			"/* exactly one of: x + y required | z required */",
		);
	});

	it("keeps the type beside format-only alternatives", () => {
		expect(render({ type: "string", anyOf: [{ format: "date" }, { format: "date-time" }] })).toBe(
			"string /* at least one of: format date | format date-time */",
		);
	});

	it("keeps union branch, tuple item and array item descriptions", () => {
		const text = render({
			type: "object",
			properties: {
				source: {
					anyOf: [
						{ type: "string", description: "A URL." },
						{ type: "object", description: "A file.", properties: { path: { type: "string" } } },
					],
				},
				pair: {
					type: "array",
					items: [{ type: "string", description: "Key." }, { type: "number" }],
					minItems: 2,
					maxItems: 2,
				},
				ids: { type: "array", items: { type: "string", description: "One id.", minLength: 2 } },
			},
		});
		expect(text).toContain("/** A URL. */ string | /** A file. */ {");
		expect(text).toContain("pair?: [/** Key. */ string, number];");
		expect(text).toContain("ids?: string[] /* each: One id.; minLength 2 */;");
	});
});

describe("checkFidelity", () => {
	it("flags unresolved references and a missing alternative requirement", () => {
		const remote = server([
			{
				name: "t",
				inputSchema: { type: "object", properties: { r: { $ref: "https://example.com/x.json" } } },
			},
		]);
		expect(checkFidelity(remote, renderServer(remote)).problems).toEqual(["t: renders unresolved $ref"]);
		const either = server([
			{
				name: "t",
				inputSchema: {
					type: "object",
					properties: { a: { type: "string" }, b: { type: "string" } },
					anyOf: [{ required: ["a"] }, { required: ["b"] }],
				},
			},
		]);
		const text = renderServer(either);
		expect(checkFidelity(either, text).ok).toBe(true);
		expect(checkFidelity(either, text.replace(" /* at least one of: a required | b required */", "")).problems).toEqual(
			["t: loses the alternative requiring a", "t: loses the alternative requiring b"],
		);
	});

	it("rejects field overrides for paths the schema lacks and ones that call a required field optional", () => {
		const catalog = server([
			{
				name: "t",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" }, items: { type: "array", items: { properties: { n: {} } } } },
					required: ["id"],
				},
				outputSchema: { type: "object", properties: { total: { type: "number" } } },
			},
		]);
		const good = { fields: { t: { id: "Record id.", "items.n": "Count.", "output.total": "Sum." } } };
		expect(checkFidelity(catalog, renderServer(catalog, good), good).problems).toEqual([]);
		const bad = { fields: { t: { id: "Optional id.", ghost: "Nope.", "output.missing": "Nope." } } };
		expect(checkFidelity(catalog, renderServer(catalog, bad), bad).problems).toEqual([
			"t.id: calls a required field optional",
			"t.ghost: no such field",
			"t.output.missing: no such field",
		]);
	});
});

describe("presentation keeps a tool's JSON declaration when its block is not faithful", () => {
	it("declares only faithful tools as thin stubs", () => {
		const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
		const plain = { name: "plain", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
		const remote = {
			name: "remote",
			inputSchema: { type: "object", properties: { r: { $ref: "https://example.com/x.json" } } },
		};
		presentation.sync("s", "s", undefined, [plain, remote]);
		presentation.describe("s", ["plain", "remote"], undefined, true);
		expect(presentation.isThin("s", plain)).toBe(true);
		expect(presentation.isThin("s", remote)).toBe(false);
		expect(presentation.signature("s", "remote")).toBeUndefined();
	});
});

describe("shared field docs are attributed exactly", () => {
	const tool = (name: string, properties: Record<string, unknown>) => ({
		name,
		inputSchema: { type: "object", properties },
	});
	const path = { type: "string", description: "Workspace file." };

	it("shares a doc only when every field of that name has it", () => {
		const agreeing = server([tool("a", { path }), tool("b", { path }), tool("c", { path })]);
		expect(renderServer(agreeing)).toContain("\t * path: Workspace file.");
		const mixed = server([
			tool("a", { path }),
			tool("b", { path }),
			tool("c", { path }),
			tool("d", { path: { type: "string" } }),
			tool("e", { nested: { type: "object", properties: { path: { type: "string", description: "Remote URL." } } } }),
		]);
		const text = renderServer(mixed);
		expect(text).not.toContain(" * path:");
		expect(toolBlock(text, "d")).not.toContain("Workspace file.");
		expect(toolBlock(text, "e")).toContain("/** Remote URL. */ path?: string;");
		expect(toolBlock(text, "e")).not.toContain("Workspace file.");
		expect(toolBlock(text, "a")).toContain("/** Workspace file. */ path?: string;");
	});
});

describe("function names match the names the model calls", () => {
	const empty = { type: "object" };

	it("names colliding tools after their registered names and says how to call others", () => {
		const tools = [
			{ name: "get-x", inputSchema: empty },
			{ name: "get_x", inputSchema: empty },
		];
		const lone = server(tools);
		const names = functionNames(lone);
		const assigned = assignMcpToolNames("s", ["get-x", "get_x"]);
		expect(names.get("get-x")?.call).toBe(assigned.get("get-x"));
		expect(names.get("get_x")?.call).toBe(assigned.get("get_x"));
		expect(names.get("get-x")?.fn).not.toBe(names.get("get_x")?.fn);
		const text = renderServer(lone);
		for (const tool of ["get-x", "get_x"]) {
			const { fn, call } = names.get(tool)!;
			expect(call).toBe(`mcp__s__${fn}`);
			expect(toolBlock(text, fn)).toContain(`function ${fn}(`);
		}
		expect(checkFidelity(lone, text).ok).toBe(true);
	});

	it("keeps a plugin server's `-` names callable through an explicit call line", () => {
		const input = server(
			[
				{ name: "get-x", inputSchema: empty },
				{ name: "get_x", inputSchema: empty },
			],
			{ server: "plugin_a_b", toolNames: { "get-x": "mcp__plugin_a_b__get-x", get_x: "mcp__plugin_a_b__get_x" } },
		);
		const names = functionNames(input);
		expect(names.get("get_x")).toEqual({ fn: "get_x", call: "mcp__plugin_a_b__get_x", explicit: false });
		expect(names.get("get-x")).toEqual({ fn: "get_x_2", call: "mcp__plugin_a_b__get-x", explicit: true });
		const text = renderServer(input);
		expect(text).toContain('A function after a "// call as <name>" line is called by that name.');
		expect(toolBlock(text, "get_x_2")).toMatch(/^\t\/\/ call as mcp__plugin_a_b__get-x\n\tfunction get_x_2\(/);
		expect(selectTools(text, ["get_x"])).not.toContain("\t// call as");
		expect(checkFidelity(input, text).ok).toBe(true);
	});

	it("hashes a call name that differs from the default, and nothing else", () => {
		const tools = [{ name: "find", inputSchema: empty }];
		expect(catalogHash(server(tools, { toolNames: { find: "mcp__s__find" } }))).toBe(catalogHash(server(tools)));
		expect(catalogHash(server(tools, { toolNames: { find: "mcp__s__find_1234abcd" } }))).not.toBe(
			catalogHash(server(tools)),
		);
	});

	it("renders the registry's names in a session", () => {
		const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
		const tools = [{ name: "find", inputSchema: empty }];
		presentation.sync("s", "s", undefined, tools, new Map([["find", "mcp__s__find_1234abcd"]]));
		expect(presentation.signature("s", "find")).toContain("function find_1234abcd(");
		expect(presentation.describe("s", ["find"], undefined, true).file).toContain("function find_1234abcd(");
	});
});
