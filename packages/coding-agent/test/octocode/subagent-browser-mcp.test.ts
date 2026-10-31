import { describe, expect, it } from "vitest";
import { MCP_BROWSER_ENV } from "../../../common/src/env.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles, profileTools } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

const profiles = () => loadProfiles(tmp(), tmp(), false, {});

describe("browser MCP server in a subagent", () => {
	it("is selected by the browser role's tools and by no other bundled role", () => {
		const roles = profiles();
		// The server is `defaultActive: false`: only a selector naming mcp__browser__ starts it in a child.
		expect(profileTools(roles.get("browser"))).toContain("mcp__browser__*");
		for (const name of ["implementer", "researcher", "reviewer"])
			expect(profileTools(roles.get(name)), name).not.toContain("mcp__browser__");
	});

	it("passes only a value the user set for the whole process", () => {
		expect(subagentProcessEnv(profiles().get("researcher"), {})).not.toHaveProperty(MCP_BROWSER_ENV);
		expect(subagentProcessEnv(profiles().get("browser"), { [MCP_BROWSER_ENV]: "0" })[MCP_BROWSER_ENV]).toBe("0");
	});

	it("leaves the child arguments, and so its research servers, unchanged", () => {
		const args = buildAgentArgs(profiles().get("researcher"), undefined, { dir: "/s", id: "a" }, []).join(" ");
		expect(args).toContain("--no-extensions -e builtin:mcp");
		expect(args).not.toContain("--no-mcp");
	});
});
