import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectPluginHooks } from "../src/core/plugin-hooks.ts";
import { inspectPluginMcp, loadConfiguredPluginMcp } from "../src/core/plugin-mcp.ts";
import { configuredPlugins } from "../src/core/plugin-settings.ts";
import { loadConfiguredPluginSkills } from "../src/core/plugin-resources.ts";
import { loadHooks } from "../src/octocode/hooks/config.ts";
import { commandsFor } from "../src/octocode/hooks/config/calls.ts";

/**
 * Adding or enabling a plugin approves its hooks and MCP servers. Settings written by older versions may still carry
 * `hooksFingerprint` or `mcpFingerprint`: they mean nothing now, and an unknown key must never drop a plugin.
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(protocol: "claude" | "codex" = "claude") {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-entries-")));
	roots.push(base);
	const plugin = path.join(base, "plugin");
	fs.mkdirSync(path.join(plugin, `.${protocol}-plugin`), { recursive: true });
	fs.mkdirSync(path.join(plugin, "hooks"));
	fs.writeFileSync(path.join(plugin, `.${protocol}-plugin`, "plugin.json"), JSON.stringify({ name: "pinned-kit" }));
	fs.writeFileSync(
		path.join(plugin, "hooks", "hooks.json"),
		JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } }),
	);
	fs.writeFileSync(
		path.join(plugin, ".mcp.json"),
		JSON.stringify({ mcpServers: { check: { command: "node", args: ["server.js"] } } }),
	);
	return { base, entry: { path: plugin, protocol } };
}

it("keeps an entry with stale fingerprint keys, whatever the value, and loads its hooks and MCP servers", () => {
	const f = fixture();
	const stale = { ...f.entry, hooksFingerprint: "a".repeat(64), mcpFingerprint: "not-a-hash", future: 1 };
	const problems: string[] = [];
	const entries = configuredPlugins([stale], (message) => problems.push(message));
	expect(problems).toEqual([]);
	expect(entries).toHaveLength(1);
	const hooks = loadHooks(f.base, false, f.base, { plugins: [stale] });
	expect(hooks.errors).toEqual([]);
	expect(commandsFor(hooks.config, "PreToolUse", ["Bash"])).toHaveLength(1);
	const mcp = loadConfiguredPluginMcp([stale], f.base);
	expect(mcp.errors).toEqual([]);
	expect(mcp.servers).toHaveLength(1);
});

it("still rejects an entry that is not a plugin", () => {
	const problems: string[] = [];
	expect(configuredPlugins([{ path: "/tmp", protocol: "unknown" }, null], (message) => problems.push(message))).toEqual(
		[],
	);
	expect(problems).toHaveLength(2);
});

it("reports the same messages for relative paths and missing manifests in every consumer", () => {
	const relative = { path: "relative/plugin", protocol: "claude" as const };
	expect(inspectPluginHooks(relative).errors).toEqual(["Error: Plugin path must be absolute"]);
	expect(inspectPluginMcp(relative).errors).toEqual(["Error: Plugin path must be absolute"]);
	expect(loadConfiguredPluginSkills([relative]).diagnostics).toEqual([
		{ type: "error", path: "relative/plugin", message: "Plugin path must be absolute" },
	]);

	const f = fixture("claude");
	const wrongProtocol = { path: f.entry.path, protocol: "codex" as const };
	const message = "Error: No valid codex plugin manifest found";
	expect(inspectPluginHooks(wrongProtocol).errors).toEqual([message]);
	expect(inspectPluginMcp(wrongProtocol).errors).toEqual([message]);
	expect(loadConfiguredPluginSkills([wrongProtocol]).diagnostics).toContainEqual({
		type: "error",
		path: f.entry.path,
		message: "No valid codex plugin manifest found",
	});
});
