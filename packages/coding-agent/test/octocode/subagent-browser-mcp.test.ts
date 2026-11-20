import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { MCP_BROWSER_ENV } from "@octocodeai/octocode-common/env";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles, profileTools } from "../../src/octocode/subagents/profiles.ts";
import { testFeatures } from "../helpers/features.ts";
import { createTestSession } from "../helpers/session.ts";
import { tmp } from "./helpers.ts";

const profiles = () => loadProfiles(tmp(), tmp(), false, {});

/** Stand-ins for the browser server's tools: one it declares, and one its configuration leaves on demand. */
const OPEN = "mcp__browser__open";
const RARE = "mcp__browser__har_pager";
const browserServer: FeatureRegister = (api) => {
	for (const [name, onDemand] of [
		[OPEN, false],
		[RARE, true],
	] as const)
		api.tools.register({
			name,
			label: name,
			description: `Browser tool ${name}`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			// The server is off by default; its rare tools are registered undeclared until first use.
			defaultActive: false,
			...(onDemand ? { onDemand: true } : {}),
		});
};

/** The tools a session with `tools` as its `--tools` list declares, beside the stand-in browser server. */
async function declaredWith(tools: string[]): Promise<string[]> {
	const cwd = tmp();
	const agentDir = tmp();
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		features: testFeatures([browserServer]),
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir,
		model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
		tools,
	});
	try {
		return session.getActiveToolNames();
	} finally {
		session.dispose();
	}
}

describe("browser MCP server in a subagent", () => {
	it("is selected by the browser role's tools and by no other bundled role", () => {
		const roles = profiles();
		// The server is `defaultActive: false`: only a selector naming mcp__browser__ starts it in a child.
		expect(profileTools(roles.get("browser"))).toContain("mcp__browser__*");
		for (const name of ["implementer", "researcher", "reviewer"])
			expect(profileTools(roles.get(name)), name).not.toContain("mcp__browser__");
	});

	it("declares the server's on-demand tools only when the role's list names one exactly, never through its pattern", async () => {
		const role = profileTools(profiles().get("browser")).split(",");
		expect(role).toContain("mcp__browser__*");
		const declared = await declaredWith(role);
		expect(declared).toContain(OPEN);
		expect(declared).not.toContain(RARE);
		expect(await declaredWith([...role, RARE])).toEqual(expect.arrayContaining([OPEN, RARE]));
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

	// Desktop control follows the browser rule: only the `desktop` profile, or a task that lists the server, starts it.
	it("excludes the desktop server for every bundled role except desktop, unless a task lists it", () => {
		const roles = profiles();
		const exclusions = (name: string, named: string[] = []) => {
			const args = buildAgentArgs(roles.get(name), undefined, { dir: "/s", id: "a" }, [], undefined, named);
			return args.includes("--exclude-tools") ? (args[args.indexOf("--exclude-tools") + 1] ?? "") : "";
		};
		for (const name of ["browser", "implementer", "researcher", "reviewer"])
			expect(exclusions(name).split(","), name).toContain("mcp__desktop__*");
		expect(exclusions("desktop")).not.toContain("mcp__desktop__");
		expect(exclusions("implementer", ["desktop"])).not.toContain("mcp__desktop__");
	});

	it("ships the desktop profile read-only with its permission declared", () => {
		const desktop = profiles().get("desktop");
		expect(desktop?.permissions).toEqual(["desktop.control"]);
		expect(desktop?.readOnly).toBe(true);
		expect(profileTools(desktop)?.split(",")).toContain("mcp__desktop__*");
	});
});
