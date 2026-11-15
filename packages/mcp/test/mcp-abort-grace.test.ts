import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

describe("MCP tool abort grace", () => {
	it("waits for an aborted call as long as the connection's own timeout", () => {
		const tool = createMcpToolDefinition({
			server: "s",
			tool: { name: "slow", description: "Slow work.", inputSchema: { type: "object" } },
			name: "mcp__s__slow",
			exposure: "direct",
			namespace: { name: "mcp__s" },
			timeoutMs: 12_000,
			getClient: async () => {
				throw new Error("not called");
			},
		});
		expect(tool.abortGraceMs).toBe(12_000);
	});
});
