import { expect, it, vi } from "vitest";
import { octocodeLaunch } from "../../src/octocode/mcp/octocode/launch.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	isBunBinary: true,
}));

it("uses Node to run the MCP entry from a compiled agent instead of relaunching the agent", () => {
	const launch = octocodeLaunch("/workspace", {}, "/installed/octocode-mcp/dist/index.js");
	expect(launch.command).toBe("node");
	expect(launch.args).toEqual(["/installed/octocode-mcp/dist/index.js"]);
});
