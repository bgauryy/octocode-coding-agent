import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { registerMcpAddedServers } from "../../../mcp/src/session-servers.ts";
import { MCP_BROWSER_ENV } from "@octocodeai/octocode-common/env";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles, profileTools } from "../../src/octocode/subagents/profiles.ts";
import { resolveTaskServers } from "../../src/octocode/subagents/task-servers.ts";
import { testFeatures } from "../helpers/features.ts";
import { createTestSession } from "../helpers/session.ts";
import { tmp } from "./helpers.ts";

const profiles = () => loadProfiles(tmp(), tmp(), false, {});

/** Stand-ins for the browser server's tools: one it declares, and one its configuration leaves on demand. */
const OPEN = "mcp__browser__open";
const RARE = "mcp__browser__protocol";
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
		// A child starts only a server its tools name: the browser role names every tool of the server exactly.
		expect(profileTools(roles.get("browser"))).toContain(OPEN);
		for (const name of ["implementer", "researcher", "reviewer"])
			expect(profileTools(roles.get(name)), name).not.toContain("mcp__browser__");
	});

	it("declares the on-demand tools of the server the role's list names exactly, and leaves a pattern's undeclared", async () => {
		// The main session takes the server's tools on demand; the browser role names each exactly so they are declared up front.
		const role = profileTools(profiles().get("browser")).split(",");
		expect(role).toEqual(expect.arrayContaining([OPEN, RARE]));
		expect(role).not.toContain("mcp__browser__*");
		expect(await declaredWith(role)).toEqual(expect.arrayContaining([OPEN, RARE]));
		const byPattern = await declaredWith(["mcp__browser__*"]);
		expect(byPattern).toContain(OPEN);
		expect(byPattern).not.toContain(RARE);
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
	// A child runs only the servers its tools or task name: browser and desktop belong to the roles that name them.
	it("gives the browser server only to the browser and desktop roles, and the desktop server only to the desktop role or a task listing it", () => {
		const roles = profiles();
		const events = createEventBus();
		registerMcpAddedServers(events, () => ({
			servers: {},
			stopped: [],
			available: ["browser", "desktop", "octocode"],
		}));
		const runs = (name: string, named?: string[]) => resolveTaskServers(events, named, roles.get(name))?.only ?? [];
		for (const name of ["implementer", "researcher", "reviewer"]) {
			expect(runs(name), name).not.toContain("browser");
			expect(runs(name), name).not.toContain("desktop");
		}
		expect(runs("browser")).toEqual(["browser", "octocode"]);
		expect(runs("desktop")).toEqual(["browser", "desktop", "octocode"]);
		expect(runs("implementer", ["desktop"])).toContain("desktop");
		expect(runs("lean")).toEqual([]);
	});

	it("ships the desktop profile read-only with its permission declared", () => {
		const desktop = profiles().get("desktop");
		expect(desktop?.permissions).toEqual(["desktop.control", "browser.control"]);
		expect(desktop?.readOnly).toBe(true);
		// No shell: untrusted screen text must never reach a command line.
		expect(desktop?.excludeTools).toBe("bash");
		// The child's half of the exchange: it leads with the outcome, names evidence paths, and says what stays open for a message.
		expect(desktop?.prompt).toMatch(/outcome word first, then the app|After the outcome word: the app/);
		expect(desktop?.prompt).toMatch(/screenshot paths/);
		expect(desktop?.prompt).toMatch(/report `blocked`/);
		expect(desktop?.linger).toBeGreaterThan(0);
		// One small image is read inline (an extra request costs more).
		expect(desktop?.prompt).toMatch(/attach one small screenshot \(`include_screenshot: true`\)/);
		// Every specialist but lean gets the research server.
		expect(desktop?.tools).toMatch(/mcp__octocode__\*/);
		// The two cheap habits the live runs lacked: the menu quit's argument shape, and a quit confirmed by the pid's windows.
		expect(desktop?.prompt).toMatch(/`invoke_menu` takes the numbers `pid` and `window_id` and `path` as a list/);
		expect(desktop?.prompt).toMatch(/Confirm the quit with `list_windows` for that `pid`, never `list_apps`/);
		// A keystroke sent while another app is in front lands in that app; a sheet's button is pressed by token.
		expect(desktop?.prompt).toMatch(/proves the target window is frontmost/);
		expect(desktop?.prompt).toMatch(/save or confirm sheet belongs to its window/);
		expect(profileTools(desktop)?.split(",")).toContain("mcp__desktop__*");
	});
});

describe("the bundled desktop child", () => {
	it("is started without a shell, and its consent text claims none", () => {
		const roles = loadProfiles(tmp(), tmp(), false, {});
		const args = buildAgentArgs(roles.get("desktop"), undefined, { dir: "/s", id: "a" }, []);
		expect(args[args.indexOf("--exclude-tools") + 1]?.split(",")).toContain("bash");
	});
});
