import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { McpClient } from "../src/client/index.ts";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

function definition(callTool: McpClient["callTool"]) {
	return createMcpToolDefinition({
		server: "s",
		tool: { name: "slow", description: "Slow work.", inputSchema: { type: "object" } },
		name: "mcp__s__slow",
		exposure: "direct",
		namespace: { name: "mcp__s" },
		timeoutMs: 1000,
		getClient: async () => ({ callTool }),
	});
}

describe("MCP tool progress", () => {
	it("reports the server's progress as structured progress beside its text", async () => {
		const updates: AgentToolResult<unknown>[] = [];
		const tool = definition(async (_name, _args, options) => {
			options?.onProgress?.({ progress: 2, total: 4, message: "half\u0007 done" });
			options?.onProgress?.({ progress: 5 });
			return { content: [{ type: "text", text: "ok" }] };
		});
		await tool.execute("call", {}, undefined, (update) => updates.push(update), {} as never);
		expect(updates.map((update) => [update.content, update.progress])).toEqual([
			// Control characters are shown escaped, never sent to the terminal.
			[[{ type: "text", text: "half\\u{7} done" }], { progress: 2, total: 4, message: "half\\u{7} done" }],
			[[{ type: "text", text: "Progress 5" }], { progress: 5 }],
		]);
	});

	it("draws a meter for a running call with progress and the output once it completes", () => {
		const tool = definition(vi.fn());
		const theme = { fg: (_color: string, text: string) => text } as never;
		const context = (isPartial: boolean) =>
			({ isPartial, isError: false, showImages: false, lastComponent: undefined, expanded: false }) as never;
		const running = tool.renderResult!(
			{
				content: [{ type: "text", text: "half" }],
				details: { server: "s", tool: "slow" },
				progress: { progress: 2, total: 4, message: "half" },
			},
			{ expanded: false, isPartial: true },
			theme,
			context(true),
		);
		expect(running.render(80).join("\n")).toContain(`${"█".repeat(10)}${"░".repeat(10)} 2/4 (50%) · half`);
	});
});
