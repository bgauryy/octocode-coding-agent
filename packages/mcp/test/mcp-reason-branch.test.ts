import { readFileSync } from "node:fs";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const define = (inputSchema: Record<string, unknown>) =>
	createMcpToolDefinition({
		server: "third",
		tool: { name: "note", inputSchema },
		name: "mcp__third__note",
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => {
			throw new Error("not called");
		},
		compact: { signature: () => undefined },
	});

// A `reason` is the server's to declare: the host sends what the model wrote and names `reason` in a call shape only
// when the server declares it.
describe("MCP reason argument declared outside the root properties", () => {
	it("keeps a reason a root alternative declares, and names it in the call shape", () => {
		const tool = define({
			type: "object",
			oneOf: [
				{ type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
				{ type: "object", properties: { x: {} } },
			],
		});
		expect(tool.prepareArguments).toBeUndefined();
		expect(tool.parameters).toMatchObject({ properties: { reason: { type: "string" } } });
		expect(tool.validationHint?.({ envelope: true })).toContain('takes only {"reason":"..."}');
	});

	it("keeps a reason declared behind a root $ref", () => {
		const tool = define({
			$ref: "#/$defs/Args",
			$defs: { Args: { type: "object", properties: { reason: { type: "string" } } } },
		});
		expect(tool.prepareArguments).toBeUndefined();
		expect(tool.coerceArguments).toBe(false);
	});

	it("rewrites no Octocode tool's arguments and leaves an undeclared reason out of the call shape", () => {
		const catalog = JSON.parse(
			readFileSync(new URL("fixtures/compact/catalog-research.json", import.meta.url), "utf8"),
		) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
		for (const { inputSchema } of catalog.tools) {
			const tool = define(inputSchema);
			expect(tool.prepareArguments).toBeUndefined();
			expect(tool.coerceArguments).toBe(false);
		}
		const undeclared = define({ type: "object", properties: { q: { type: "string" } }, required: ["q", "reason"] });
		expect(undeclared.validationHint?.({ envelope: true })).toBe(
			'mcp__third__note takes only {"q":"..."} as its arguments, with no other top-level property.',
		);
	});
});

// B150: in declared presentation (no compact signature, no queries cap) a native `reason` copied into the call failed
// with only "unexpected property reason"; the failure now names the accepted call shape, and the input stays unchanged.
describe("MCP declared tool sent an undeclared reason", () => {
	it("rejects the call and names the call shape without reason", () => {
		const tool = createMcpToolDefinition({
			server: "third",
			tool: {
				name: "note",
				inputSchema: {
					type: "object",
					properties: { q: { type: "string" } },
					required: ["q"],
					additionalProperties: false,
				},
			},
			name: "mcp__third__note",
			exposure: "direct",
			namespace: "mcp" as never,
			timeoutMs: 1000,
			getClient: async () => {
				throw new Error("not called");
			},
		});
		const call = (args: Record<string, unknown>) =>
			validateToolArguments(tool as never, { type: "toolCall", id: "c", name: tool.name, arguments: args } as never);
		expect(() => call({ q: "x", reason: "why" })).toThrow(
			/unexpected property reason[\s\S]*mcp__third__note takes only \{"q":"\.\.\."\} as its arguments, with no other top-level property\./,
		);
		expect(call({ q: "x" })).toEqual({ q: "x" });
	});
});
