import { describe, expect, it } from "vitest";
import { MCP_BROWSER_ENV, MCP_DESKTOP_ENV } from "@octocodeai/octocode-common/env";
import { BROWSER_BIN, DESKTOP_BIN } from "@octocodeai/octocode-common/mcp-names";
import data from "../src/default_mcp_config.json" with { type: "json" };
import {
	defaultAgentMcp,
	defaultServerNames,
	defaultServerPreset,
	parseDefaultMcpConfig,
} from "../src/presets/default-config.ts";
import { builtinPresets } from "../src/presets/index.ts";

const copy = (): { servers: Record<string, unknown>; agents: Record<string, Record<string, string[]>> } =>
	structuredClone(data) as never;

describe("default_mcp_config.json", () => {
	it("registers every server it lists, in its order, and nothing else", () => {
		expect(builtinPresets({}).map(({ name }) => name)).toEqual(Object.keys(data.servers));
		expect(defaultServerNames()).toEqual(["octocode", "freellama", "browser", "desktop"]);
	});

	it("names, for every agent, only servers the file defines", () => {
		const known = Object.keys(data.servers);
		for (const agent of Object.keys(data.agents)) {
			const assigned = defaultAgentMcp(agent)!;
			const servers = assigned.servers ?? assigned.tools.map((tool) => /^mcp__([^_]+)__/.exec(tool)?.[1]);
			for (const server of servers) expect(known, `${agent}: ${server}`).toContain(server);
		}
		const bad = copy();
		bad.agents.researcher = { servers: ["nope"] };
		expect(() => parseDefaultMcpConfig(bad)).toThrow(/agent "researcher": unknown server "nope"/);
		const badTool = copy();
		badTool.agents.browser = { tools: ["mcp__nope__open"] };
		expect(() => parseDefaultMcpConfig(badTool)).toThrow(/agent "browser": "mcp__nope__open"/);
	});

	it("fails loudly on a malformed agent or a missing main", () => {
		const both = copy();
		both.agents.lean = { servers: [], tools: [] };
		expect(() => parseDefaultMcpConfig(both)).toThrow(/either `servers` or `tools`/);
		const noMain = copy();
		delete noMain.agents.main;
		expect(() => parseDefaultMcpConfig(noMain)).toThrow(/agent `main`/);
		expect(() => parseDefaultMcpConfig({ servers: {} })).toThrow(/`servers` and `agents`/);
	});

	it("assigns the main agent every server but the desktop, which it delegates", () => {
		const defaultActive = builtinPresets({}).map(({ name, config }) => [name, config?.defaultActive]);
		expect(defaultActive).toEqual([
			["octocode", undefined],
			["freellama", undefined],
			["browser", undefined],
			["desktop", false],
		]);
	});

	it("resolves a profile's server names to every tool of that server and keeps its tool names", () => {
		expect(defaultAgentMcp("desktop")).toEqual({
			tools: ["mcp__desktop__*", "mcp__browser__*", "mcp__octocode__*"],
		});
		expect(defaultAgentMcp("browser")?.tools).toContain("mcp__browser__open");
		expect(defaultAgentMcp("browser")?.tools?.at(-1)).toBe("mcp__octocode__*");
		expect(defaultAgentMcp("researcher")).toEqual({ servers: ["octocode"] });
		expect(defaultAgentMcp("lean")).toEqual({ servers: [] });
		expect(defaultAgentMcp("someone-else")).toBeUndefined();
	});

	it("removes a server from an agent when the file stops listing it there", () => {
		const edited = copy();
		edited.agents.desktop = { tools: ["octocode"] };
		edited.agents.main = { servers: ["octocode", "freellama"] };
		const config = parseDefaultMcpConfig(edited);
		expect(defaultAgentMcp("desktop", config)?.tools).toEqual(["mcp__octocode__*"]);
		expect(defaultServerPreset("browser", {}, config).config?.defaultActive).toBe(false);
		expect(defaultServerPreset("octocode", {}, config).config?.defaultActive).toBeUndefined();
	});

	it("keeps the launch names and flags the rest of Octocode uses for the browser and desktop", () => {
		expect(data.servers.browser).toMatchObject({ command: BROWSER_BIN, enabledEnv: MCP_BROWSER_ENV });
		expect(data.servers.desktop).toMatchObject({ command: DESKTOP_BIN, enabledEnv: MCP_DESKTOP_ENV });
	});
});
