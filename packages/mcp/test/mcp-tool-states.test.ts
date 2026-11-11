import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type McpExposure, type McpServerEntry, updateMcpServerConfig } from "../src/config.ts";
import type { McpServer } from "../src/server.ts";
import { getMcpToolExposure } from "../src/servers.ts";
import { currentMcpToolStates, mcpToolStates, publishMcpToolStates } from "../src/tool-states.ts";

const server = (name: string, config: Partial<McpServerEntry["config"]>, tools: string[] | undefined): McpServer =>
	({
		entry: { name, config: { command: "x", ...config }, source: "/mcp.json", scope: "global" },
		...(tools ? { connection: { state: "connected", tools: tools.map((tool) => ({ name: tool })) } } : {}),
	}) as unknown as McpServer;

/** A state whose session defers the named `server/tool` keys, as the frozen prompt block would. */
const source = (servers: McpServer[], setting: unknown, deferred: string[] = []) => ({
	servers,
	exposureSetting: () => setting,
	toolExposure: (entry: McpServerEntry, tool: string): McpExposure => {
		const configured = getMcpToolExposure(entry.config, tool);
		return configured === "direct" && deferred.includes(`${entry.name}/${tool}`) ? "deferred" : configured;
	},
});

describe("mcpToolStates", () => {
	it("names what decided each tool: a pin, a pattern, the server, recent use or the default", () => {
		const docs = server("docs", { toolExposure: { search: "deferred", "admin_*": "hidden" } }, [
			"search",
			"admin_drop",
			"read",
			"list",
		]);
		const [recent] = mcpToolStates(source([docs], "recent", ["docs/list"]));
		expect(recent).toMatchObject({ server: "docs", connected: true, saved: true });
		expect(recent.tools).toEqual([
			{ name: "search", state: "deferred", decidedBy: "pin" },
			{ name: "admin_drop", state: "hidden", decidedBy: "pattern" },
			{ name: "read", state: "direct", decidedBy: "recent" },
			{ name: "list", state: "deferred", decidedBy: "recent" },
		]);
		const [plain] = mcpToolStates(source([docs], "direct"));
		expect(plain.tools.slice(2)).toEqual([
			{ name: "read", state: "direct", decidedBy: "default" },
			{ name: "list", state: "direct", decidedBy: "default" },
		]);
		const [budget] = mcpToolStates(source([docs], "auto:100", ["docs/read"]));
		expect(budget.tools[2]).toEqual({ name: "read", state: "deferred", decidedBy: "setting" });
	});

	it("reports the server's own exposure, skips disabled servers and lists no tools before a connection", () => {
		const hidden = server("quiet", { exposure: "deferred" }, ["a"]);
		const off = server("off", { enabled: false }, ["a"]);
		const starting = server("starting", {}, undefined);
		const registered = { ...server("ext", {}, ["a"]) };
		registered.entry = { ...registered.entry, scope: "extension" };
		const states = mcpToolStates(source([hidden, off, starting, registered], "recent"));
		expect(states.map((state) => state.server)).toEqual(["quiet", "starting", "ext"]);
		expect(states[0].tools).toEqual([{ name: "a", state: "deferred", decidedBy: "server" }]);
		expect(states[1]).toMatchObject({ connected: false, tools: [] });
		expect(states[2].saved).toBe(false);
	});

	it("answers through the published reader", () => {
		publishMcpToolStates(() => mcpToolStates(source([server("docs", {}, ["read"])], "direct")));
		expect(currentMcpToolStates()?.[0].tools).toEqual([{ name: "read", state: "direct", decidedBy: "default" }]);
	});
});

describe("updateMcpServerConfig with toolExposure", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});
	const file = (content: unknown) => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-mcp-pins-"));
		dirs.push(dir);
		const path = join(dir, "mcp.json");
		writeFileSync(path, JSON.stringify(content));
		return path;
	};
	const servers = (path: string) => JSON.parse(readFileSync(path, "utf8")).mcpServers;

	it("replaces a definition's pins, keeps its other keys and removes an empty map", () => {
		const path = file({
			mcpServers: { docs: { command: "docs", exposure: "deferred", toolExposure: { a: "hidden" } } },
		});
		updateMcpServerConfig(path, "docs", { toolExposure: { a: "hidden", b: "direct" } });
		expect(servers(path).docs).toEqual({
			command: "docs",
			exposure: "deferred",
			toolExposure: { a: "hidden", b: "direct" },
		});
		updateMcpServerConfig(path, "docs", { toolExposure: {} });
		expect(servers(path).docs).toEqual({ command: "docs", exposure: "deferred" });
	});

	it("keeps an empty map in an override, where it clears the pins of the server it overrides", () => {
		const path = file({ mcpServers: {} });
		updateMcpServerConfig(path, "docs", { toolExposure: { a: "deferred" } }, { override: true });
		expect(servers(path).docs).toEqual({ toolExposure: { a: "deferred" } });
		updateMcpServerConfig(path, "docs", { toolExposure: {} }, { override: true });
		expect(servers(path).docs).toEqual({ toolExposure: {} });
	});
});
