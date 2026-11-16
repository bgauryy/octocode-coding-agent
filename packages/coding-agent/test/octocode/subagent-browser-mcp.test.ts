import { describe, expect, it } from "vitest";
import { MCP_BROWSER_ENV } from "@octocodeai/octocode-common/env";
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

	it("keeps its research servers and excludes only the browser server", () => {
		const args = buildAgentArgs(profiles().get("researcher"), undefined, { dir: "/s", id: "a" }, []).join(" ");
		// The built-in MCP host is on by default, so the child is not told to enable it.
		expect(args).not.toContain("builtin:mcp");
		expect(args).not.toContain("--no-extensions");
		expect(args).not.toContain("--no-mcp");
	});

	// A main-session opt-in (`defaultTools` entries, `defaultActive: true`, `/mcp assign browser all`) is read by every
	// child from the same settings; the exclusion keeps it in the main session and the profiles that name the server.
	it("excludes the browser server for every bundled role except browser", () => {
		const roles = profiles();
		const argsOf = (name: string) => buildAgentArgs(roles.get(name), undefined, { dir: "/s", id: "a" }, []);
		for (const name of ["implementer", "researcher", "reviewer"]) {
			const args = argsOf(name);
			expect(args[args.indexOf("--exclude-tools") + 1]?.split(","), name).toContain("mcp__browser__*");
		}
		const browser = argsOf("browser");
		expect(browser.includes("--exclude-tools") ? browser[browser.indexOf("--exclude-tools") + 1] : "").not.toContain(
			"mcp__browser__",
		);
	});
});
