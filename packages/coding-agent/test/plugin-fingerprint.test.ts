import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectPluginHooks } from "../src/core/plugin-hooks.ts";
import { inspectPluginMcp } from "../src/core/plugin-mcp.ts";
import { loadConfiguredPluginSkills } from "../src/core/plugin-resources.ts";

/**
 * Approval fingerprints are stored in user settings, so their hash input must never change. Each expected value is
 * computed here from the documented recipe, independent of the implementation.
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(protocol: "claude" | "codex" = "claude") {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-fingerprint-")));
	roots.push(base);
	const plugin = path.join(base, "plugin");
	const manifestPath = path.join(plugin, `.${protocol}-plugin`, "plugin.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.mkdirSync(path.join(plugin, "hooks"));
	const manifestText = JSON.stringify({ name: "pinned-kit" });
	const hooksText = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } });
	const mcpText = JSON.stringify({ mcpServers: { check: { command: "node", args: ["server.js"] } } });
	fs.writeFileSync(manifestPath, manifestText);
	fs.writeFileSync(path.join(plugin, "hooks", "hooks.json"), hooksText);
	fs.writeFileSync(path.join(plugin, ".mcp.json"), mcpText);
	const digest = (parts: unknown[][]) => {
		const hash = createHash("sha256");
		for (const part of parts) hash.update(JSON.stringify(part));
		return hash.digest("hex");
	};
	const head = [plugin, protocol, "pinned-kit"];
	return {
		entry: { path: plugin, protocol },
		hooksFingerprint: digest([
			head,
			[manifestPath, manifestText],
			[path.join(plugin, "hooks", "hooks.json"), hooksText],
		]),
		mcpFingerprint: digest([head, [manifestPath, manifestText], [path.join(plugin, ".mcp.json"), mcpText]]),
	};
}

it("keeps the hooks and MCP approval fingerprints byte-identical", () => {
	const f = fixture();
	expect(inspectPluginHooks(f.entry)).toMatchObject({ errors: [], fingerprint: f.hooksFingerprint });
	expect(inspectPluginMcp(f.entry)).toMatchObject({ errors: [], fingerprint: f.mcpFingerprint });
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
