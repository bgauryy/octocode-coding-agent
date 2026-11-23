import { createEventBus } from "@octocodeai/octocode-agent-core";
import { describe, expect, it } from "vitest";
import { type McpServerStatus, setMcpSessionStatus } from "../../mcp/src/status.ts";
import { mcpRow } from "../src/modes/interactive/interactive-mode/loaded-mcp.ts";

const server = (name: string, state: string, enabled = true): McpServerStatus => ({
	name,
	enabled,
	state,
	exposure: "direct",
	toolCount: 0,
	source: "test",
});

describe("the startup MCP row", () => {
	it("counts a server the security review holds back as off, though its switch is on", () => {
		const events = createEventBus();
		setMcpSessionStatus(events, [server("octocode", "connected"), server("demo", "not checked")]);
		const row = mcpRow(events);
		expect(row.summary?.()).toBe("1 on (octocode) · 1 off (demo) · /mcp");
		setMcpSessionStatus(events, [server("demo", "not checked")]);
		expect(row.state?.()).toBe("off");
	});
});
