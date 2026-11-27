import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { registerMcpAddedServers } from "../../../mcp/src/session-servers.ts";
import data from "../../../mcp/src/default_mcp_config.json" with { type: "json" };
import { defaultAgentMcp, parseDefaultMcpConfig } from "../../../mcp/src/presets/default-config.ts";
import { GENERAL_PROFILE, loadProfiles, parseProfile } from "../../src/octocode/subagents/profiles.ts";
import { resolveTaskServers } from "../../src/octocode/subagents/task-servers.ts";

const dirs: string[] = [];
function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-default-mcp-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const bundled = () => loadProfiles(tmp(), tmp(), false, { OCTOCODE_HOME: tmp() });
const bundledText = (name: string) =>
	fs.readFileSync(new URL(`../../src/octocode/native/agents/${name}.md`, import.meta.url), "utf8");

/** The servers a child of `profile` runs in a session that offers every default server and one of the user's. */
function childServers(profile: Parameters<typeof resolveTaskServers>[2]): string[] {
	const events = createEventBus();
	const available = ["octocode", "freellama", "browser", "desktop", "mine"];
	registerMcpAddedServers(events, () => ({ servers: {}, stopped: [], available }));
	return resolveTaskServers(events, undefined, profile)?.only ?? [];
}

describe("MCP servers of bundled profiles, from the default MCP config", () => {
	it("lists every bundled profile and the profile-less child, and nothing else besides main", () => {
		const agents = Object.keys(data.agents).filter((name) => name !== "main");
		expect(agents.toSorted()).toEqual([...bundled().keys(), GENERAL_PROFILE].toSorted());
	});

	it("gives each agent the servers it had when its profile named them itself", () => {
		const profiles = bundled();
		expect(childServers(profiles.get("browser"))).toEqual(["octocode", "browser"]);
		expect(childServers(profiles.get("desktop"))).toEqual(["octocode", "browser", "desktop"]);
		for (const name of ["researcher", "reviewer", "implementer"])
			expect(childServers(profiles.get(name)), name).toEqual(["octocode"]);
		expect(childServers(undefined)).toEqual(["octocode"]);
		expect(resolveTaskServers(createEventBus(), undefined, profiles.get("lean"))).toBeUndefined();
		expect(profiles.get("browser")?.tools?.split(",").slice(0, 2)).toEqual([
			"mcp__browser__open",
			"mcp__browser__group",
		]);
		expect(profiles.get("browser")?.tools?.split(",")).toEqual(expect.arrayContaining(["mcp__octocode__*", "web"]));
		expect(profiles.get("desktop")?.tools?.split(",").slice(0, 3)).toEqual([
			"mcp__desktop__*",
			"mcp__browser__*",
			"mcp__octocode__*",
		]);
	});

	it("drops a server from an agent when the config stops listing it there", () => {
		const edited = structuredClone(data) as { agents: Record<string, unknown> };
		edited.agents.desktop = { tools: ["octocode"] };
		const config = parseDefaultMcpConfig(edited);
		const desktop = parseProfile("desktop", bundledText("desktop"), undefined, (name) => defaultAgentMcp(name, config));
		expect(desktop.tools).not.toContain("mcp__desktop__");
		expect(childServers(desktop)).toEqual(["octocode"]);
	});

	it("changes a bundled profile's identity when its assignment changes", () => {
		const text = bundledText("desktop");
		const a = parseProfile("desktop", text, undefined, () => ({ tools: ["mcp__desktop__*"] }));
		const b = parseProfile("desktop", text, undefined, () => ({ tools: ["mcp__octocode__*"] }));
		expect(a.hash).not.toBe(b.hash);
	});

	it("refuses an assignment for a lean profile, which runs no MCP", () => {
		expect(() => parseProfile("lean", bundledText("lean"), undefined, () => ({ servers: ["octocode"] }))).toThrow(
			/lean and runs no MCP server/,
		);
	});

	it("leaves a user's profile of a bundled name to its own tools", () => {
		const home = tmp();
		const agents = path.join(home, "agents");
		fs.mkdirSync(agents, { recursive: true });
		const own = "---\nname: desktop\ndescription: mine\ntools: mcp__mine__*\n---\nMine.\n";
		fs.writeFileSync(path.join(agents, "desktop.md"), own);
		const desktop = loadProfiles(tmp(), tmp(), false, { OCTOCODE_HOME: home }).get("desktop");
		expect(desktop?.tools?.split(",")[0]).toBe("mcp__mine__*");
		expect(desktop?.tools).not.toContain("mcp__desktop__");
		expect(childServers(desktop)).toEqual(["mine"]);
	});
});
