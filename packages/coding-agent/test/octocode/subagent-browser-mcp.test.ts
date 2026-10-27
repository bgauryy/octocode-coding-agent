import { describe, expect, it } from "vitest";
import { MCP_BROWSER_ENV } from "../../src/octocode/shared/env.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles, parseProfile, profileSelectsBrowser } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

const profiles = () => loadProfiles(tmp(), tmp(), false, {});
const profile = (tools?: string) =>
	parseProfile("custom", `---\nname: custom\ndescription: d\n${tools ? `tools: ${tools}\n` : ""}---\nbody`);

describe("browser MCP server in a subagent", () => {
	it("is switched off for roles without browser tools and kept for the browser role", () => {
		const roles = profiles();
		for (const name of ["implementer", "researcher", "reviewer"])
			expect(subagentProcessEnv(roles.get(name), {})[MCP_BROWSER_ENV], name).toBe("0");
		expect(subagentProcessEnv(undefined, {})[MCP_BROWSER_ENV]).toBe("0");
		expect(subagentProcessEnv(roles.get("browser"), {})).not.toHaveProperty(MCP_BROWSER_ENV);
	});

	it("follows the profile's own tool selection, native or MCP", () => {
		expect(profileSelectsBrowser(profile("+browser"))).toBe(true);
		expect(profileSelectsBrowser(profile("mcp__browser__*"))).toBe(true);
		expect(profileSelectsBrowser(profile("mcp__octocode__*"))).toBe(false);
		expect(profileSelectsBrowser(profile())).toBe(false);
	});

	it("keeps a value the user set for the whole process", () => {
		const env = subagentProcessEnv(profiles().get("browser"), { [MCP_BROWSER_ENV]: "0" });
		expect(env[MCP_BROWSER_ENV]).toBe("0");
	});

	it("leaves the child arguments, and so its research and tool-search servers, unchanged", () => {
		const args = buildAgentArgs(profiles().get("researcher"), undefined, { dir: "/s", id: "a" }, []).join(" ");
		expect(args).toContain("-e builtin:mcp -e builtin:tool-search");
		expect(args).not.toContain("--no-mcp");
	});
});
