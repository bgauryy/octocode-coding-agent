import { readFileSync } from "node:fs";
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

// The host drops the `reason` models copy from native tools, unless the server declares one itself.
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
	});

	it("still drops an invented reason for the current Octocode tools and leaves it out of the call shape", () => {
		const catalog = JSON.parse(
			readFileSync(new URL("fixtures/compact/octocode-catalog.json", import.meta.url), "utf8"),
		) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
		for (const { inputSchema } of catalog.tools) {
			const tool = define(inputSchema);
			expect(tool.prepareArguments?.({ cursor: "c", reason: "copied from a native tool" })).toEqual({ cursor: "c" });
		}
		const undeclared = define({ type: "object", properties: { q: { type: "string" } }, required: ["q", "reason"] });
		expect(undeclared.validationHint?.({ envelope: true })).toBe(
			'mcp__third__note takes only {"q":"..."} as its arguments, with no other top-level property.',
		);
	});
});
