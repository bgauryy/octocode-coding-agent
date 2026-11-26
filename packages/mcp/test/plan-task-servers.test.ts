import { describe, expect, it } from "vitest";
import { planTaskMcpServers } from "../src/session-servers.ts";

// The session runs octocode only: browser is assigned by the default agents map but disabled, desktop is absent.
const handoff = { servers: {}, stopped: [], available: ["octocode"] };

describe("a child's servers from its assigned tool patterns", () => {
	it("keeps an assigned server the session runs and skips one it does not, without refusing", () => {
		const planned = planTaskMcpServers(handoff, [], ["bash", "mcp__octocode__*", "mcp__browser__*", "mcp__desktop__*"]);
		expect(planned).toEqual({ only: ["octocode"], servers: {} });
	});

	it("gives no server to a child whose patterns name none the session runs", () => {
		expect(planTaskMcpServers(handoff, [], ["bash", "mcp__browser__*"])).toEqual({ only: [], servers: {} });
	});

	it("refuses a disabled server the task names explicitly", () => {
		expect(planTaskMcpServers(handoff, ["browser"], [])).toMatch(/Unknown or disabled MCP server "browser"/);
	});
});
