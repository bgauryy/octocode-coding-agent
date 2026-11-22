import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpClient } from "../src/client/index.ts";
import { installMcpHost } from "../src/host.ts";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

function definition(callTool: McpClient["callTool"]) {
	return createMcpToolDefinition({
		server: "srv",
		tool: { name: "slow", description: "Slow work.", inputSchema: { type: "object" } },
		name: "mcp__srv__slow",
		exposure: "direct",
		namespace: { name: "mcp__srv" },
		timeoutMs: 1000,
		getClient: async () => ({ callTool }),
	});
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

afterEach(() => {
	installMcpHost({ calls: undefined });
});

describe("MCP tool calls through the host's calls port", () => {
	it("runs the call directly when the host installed no port", async () => {
		const tool = definition(async () => ok("direct"));
		const result = await tool.execute("id", {}, undefined, undefined, {} as never);
		expect(result.content).toEqual([{ type: "text", text: "direct" }]);
	});

	it("hands the call's work to the port with the call's identity, and returns the port's reply", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const handedOver: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "task-1 started" }],
			details: { kind: "job-started" },
		};
		installMcpHost({
			calls: {
				run: async (call) => {
					seen.push({ tool: call.tool, title: call.title, reason: call.reason, ctx: call.ctx });
					return handedOver as never;
				},
			},
		});
		const callTool = vi.fn();
		const ctx = { cwd: "/x" } as never;
		const reply = await definition(callTool).execute("id", { path: "a", reason: "why" }, undefined, undefined, ctx);
		expect(reply).toBe(handedOver);
		expect(callTool).not.toHaveBeenCalled();
		expect(seen).toEqual([{ tool: "mcp__srv__slow", title: expect.stringContaining("srv/slow"), reason: "why", ctx }]);
		expect(seen[0].title).toContain("path=a");
	});

	it("runs the server call inside the port's work, with the signal the port gives and no progress once handed over", async () => {
		const updates: string[] = [];
		const portSignal = new AbortController().signal;
		let foreground = true;
		installMcpHost({
			calls: { run: (_call, work) => work(portSignal, () => foreground) },
		});
		let serverSignal: AbortSignal | undefined;
		const tool = definition(async (_name, _args, options) => {
			serverSignal = options?.signal;
			options?.onProgress?.({ progress: 1 });
			foreground = false;
			options?.onProgress?.({ progress: 2 });
			return ok("late");
		});
		const callerSignal = new AbortController().signal;
		const result = await tool.execute(
			"id",
			{},
			callerSignal,
			(update) => updates.push(update.content[0] && "text" in update.content[0] ? update.content[0].text : ""),
			{} as never,
		);
		expect(result.content).toEqual([{ type: "text", text: "late" }]);
		expect(serverSignal).toBe(portSignal);
		expect(updates).toEqual(["Progress 1"]);
	});

	it("propagates a failure of the work through the port", async () => {
		installMcpHost({ calls: { run: (_call, work) => work(undefined, () => true) } });
		const tool = definition(async () => {
			throw new Error("server down");
		});
		await expect(tool.execute("id", {}, undefined, undefined, {} as never)).rejects.toThrow("server down");
	});
});
