import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/octocode/mcp-host/core-install.ts";
import { loadMcpConfig } from "../../../mcp/src/config.ts";
import { getAgentDir } from "../../src/config.ts";
import { registerHarnessSync } from "../../src/octocode/subagents/harness-sync.ts";
import { mcpHost } from "../../../mcp/test/mcp-host-fixture.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

const saveToggles = (toggles: Record<string, boolean>) =>
	fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ toggles }));

/** A subagent's MCP owner with its harness sync, reading the real vendor files and switches. */
async function child() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.writeFileSync(
		path.join(process.env.HOME!, ".claude.json"),
		JSON.stringify({ mcpServers: { "claude-only": { command: "never-started", enabled: false } } }),
	);
	saveToggles({});
	const host = mcpHost({
		cwd,
		loadConfig: () => loadMcpConfig({ agentDir: getAgentDir(), cwd, projectTrusted: true }),
	});
	registerHarnessSync(host.api);
	await host.start();
	const servers = () => host.state.servers.map((server) => server.entry.name);
	return { host, servers };
}

describe("a running subagent after the parent's /harness switch", () => {
	it("adds and removes the vendor's MCP servers before its next request", async () => {
		const { host, servers } = await child();
		expect(servers()).not.toContain("claude-only");

		// The parent saved `harness:claude` on: a new prompt's first request sees the server.
		saveToggles({ "harness:claude": true });
		expect(await host.fire("input", { text: "go", source: "rpc" }, host.ctx)).toEqual({ action: "continue" });
		expect(servers()).toContain("claude-only");

		// Switched off in the middle of a run: the next turn's request no longer has it.
		saveToggles({ "harness:claude": false });
		await host.fire("turn_end", { toolResults: [] }, host.ctx);
		expect(servers()).not.toContain("claude-only");
		await host.close();
	});

	it("leaves the servers alone while no harness switch changed", async () => {
		const { host, servers } = await child();
		const before = servers();
		saveToggles({ "skills:something": false });
		await host.fire("turn_end", { toolResults: [] }, host.ctx);
		expect(servers()).toEqual(before);
		await host.close();
	});

	it("says so on stderr when the settings cannot be read, and applies the switch once they can", async () => {
		const { host, servers } = await child();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		fs.writeFileSync(path.join(getAgentDir(), "settings.json"), "{ not json");
		await host.fire("turn_end", { toolResults: [] }, host.ctx);
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Harness switches not applied to this subagent"));
		stderr.mockRestore();
		saveToggles({ "harness:claude": true });
		await host.fire("turn_end", { toolResults: [] }, host.ctx);
		expect(servers()).toContain("claude-only");
		await host.close();
	});
});
