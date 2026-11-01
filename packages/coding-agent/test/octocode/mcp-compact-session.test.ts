import "../mcp-host.ts";
import { runToolCall } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, toToolDeclaration } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { OCTOCODE_SERVER } from "../../../mcp/src/presets/octocode/names.ts";
import { defineOctocodeTool, octocodeToolName } from "../../../mcp/src/presets/octocode/tools.ts";
import { fakeCtx } from "./fake-host.ts";

const inputSchema = {
	type: "object" as const,
	additionalProperties: false,
	required: ["queries"],
	properties: { queries: { type: "array", maxItems: 2, items: { type: "string" } } },
};
const SIGNATURE = "  /** Read files. */\n  function localFetch(input: { queries: string[] }): unknown;";

function setup() {
	const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
		content: [{ type: "text" as const, text: "ok" }],
	}));
	const definition = defineOctocodeTool({
		server: OCTOCODE_SERVER,
		tool: { name: "localFetch", description: "Read files. Many at once.", inputSchema },
		name: octocodeToolName("localFetch"),
		exposure: "direct",
		namespace: { name: "mcp__octocode" },
		timeoutMs: 60_000,
		getClient: async () => ({ callTool: async (name, args) => call(name, args) }),
		compact: { signature: () => SIGNATURE },
	});
	const tool = wrapToolDefinition(definition, () => fakeCtx({ cwd: "/work" }) as never);
	const run = (args: Record<string, unknown>) =>
		runToolCall(
			{ type: "toolCall", id: "call", name: tool.name, arguments: args as never },
			{
				tools: [tool],
				assistantMessage: fauxAssistantMessage("Continue"),
				context: { messages: [], tools: [tool] },
			},
		);
	return { tool, run, call };
}

describe("thin MCP declarations in the agent loop", () => {
	it("declares a summary and top-level field types in an open object, never the validation schema", () => {
		const { tool } = setup();
		expect(toToolDeclaration(tool)).toEqual({
			name: "mcp__octocode__localFetch",
			description: "Read files.",
			parameters: { type: "object", properties: { queries: { type: "array" } }, additionalProperties: true },
		});
	});

	it("refuses a call the server's schema rejects before the server, and shows the signature", async () => {
		const { run, call } = setup();
		const result = await run({ queries: "not-an-array-of-strings", extra: 1 });
		expect(result.isError).toBe(true);
		expect((result.result.content[0] as { text: string }).text).toContain(SIGNATURE);
		expect(call).not.toHaveBeenCalled();
	});

	it("runs a call that satisfies the server's schema", async () => {
		const { run, call } = setup();
		expect((await run({ queries: ["a.ts"] })).isError).toBe(false);
		expect(call).toHaveBeenCalledWith("localFetch", { queries: ["a.ts"] });
	});
});
