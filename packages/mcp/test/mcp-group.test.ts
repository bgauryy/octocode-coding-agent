import { describe, expect, it } from "vitest";
import { mcpGroupLabel, mcpServerGroup, mcpServerSource } from "../src/group.ts";

describe("MCP server groups", () => {
	it("names where a server comes from in the words skills use: core, workspace or global", () => {
		expect(mcpServerGroup({ scope: "default" })).toBe("core");
		expect(mcpServerGroup({ scope: "project" })).toBe("workspace");
		expect(mcpServerGroup({ scope: "global" })).toBe("global");
		// A plugin's or a session's server is the user's, not the repository's.
		expect(mcpServerGroup({ scope: "feature" })).toBe("global");
		expect(mcpServerGroup({})).toBe("global");
		expect(["core", "workspace", "global"].map((group) => mcpGroupLabel(group as "core"))).toEqual([
			"Core",
			"Workspace",
			"Global",
		]);
	});

	it("says built in for a preset, plugin <path> for a registered server, else the shortened file", () => {
		const short = (file: string) => file.replace("/home/me", "~");
		expect(mcpServerSource({ scope: "default", source: "built-in browser" }, short)).toBe("built in");
		expect(mcpServerSource({ scope: "feature", source: "/home/me/plugins/kit" }, short)).toBe("plugin ~/plugins/kit");
		expect(mcpServerSource({ scope: "global", source: "/home/me/.octocode/mcp.json" }, short)).toBe(
			"~/.octocode/mcp.json",
		);
		expect(mcpServerSource({ scope: "project", source: "/repo/.mcp.json" })).toBe("/repo/.mcp.json");
	});
});
