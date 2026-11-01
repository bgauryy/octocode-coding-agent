import "../mcp-host.ts";
import { expect, it } from "vitest";
import { hostIdentity, installMcpHost } from "../../../mcp/src/host.ts";
import { octocodeLaunch } from "../../../mcp/src/presets/octocode/launch.ts";

it("uses Node to run the MCP entry from a compiled agent instead of relaunching the agent", () => {
	const identity = hostIdentity();
	installMcpHost({ identity: { ...identity, isBunBinary: () => true } });
	try {
		const launch = octocodeLaunch("/workspace", {}, "/installed/octocode-mcp/dist/index.js");
		expect(launch.command).toBe("node");
		expect(launch.args).toEqual(["/installed/octocode-mcp/dist/index.js"]);
	} finally {
		installMcpHost({ identity });
	}
});
