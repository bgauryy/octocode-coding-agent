import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectPluginMcp, loadConfiguredPluginMcp } from "../src/core/plugin-mcp.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createMcpFeature } from "../../mcp/src/index.ts";
import { getMcpHookCaller } from "../../mcp/src/hook-caller.ts";
import type { FeatureSetup } from "../src/core/features/types.ts";
import { createInMemoryTransportPair } from "../../mcp/src/client/testing/index.ts";
import { LATEST_PROTOCOL_VERSION } from "../../mcp/src/client/index.ts";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { createHarness } from "./suite/harness.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { testFeatures } from "./helpers/features.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(protocol: "claude" | "codex" = "claude", declarations?: unknown) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-mcp-"));
	roots.push(root);
	const plugin = path.join(root, "plugin");
	fs.mkdirSync(path.join(plugin, `.${protocol}-plugin`), { recursive: true });
	fs.writeFileSync(
		path.join(plugin, `.${protocol}-plugin/plugin.json`),
		JSON.stringify({
			name: "review-kit",
			...(declarations === undefined ? {} : { mcpServers: declarations }),
		}),
	);
	fs.writeFileSync(
		path.join(plugin, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				check: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
			},
		}),
	);
	return { root, plugin, entry: { path: plugin, protocol } };
}
it("loads the servers of an enabled plugin and expands plugin paths", () => {
	const f = fixture();
	const inspection = inspectPluginMcp(f.entry);
	expect(inspection.errors).toEqual([]);
	const entry = f.entry;
	const loaded = loadConfiguredPluginMcp([entry], f.root);
	expect(loaded.errors).toEqual([]);
	expect(loaded.servers).toContainEqual(
		expect.objectContaining({
			name: "plugin:review-kit:check",
			config: expect.objectContaining({
				command: "node",
				args: [path.join(fs.realpathSync(f.plugin), "server.js")],
			}),
		}),
	);
	fs.writeFileSync(
		path.join(f.plugin, ".mcp.json"),
		JSON.stringify({ mcpServers: { check: { command: "different" } } }),
	);
	// Enabling approves the declarations as they stand: a later change loads as written.
	expect(loadConfiguredPluginMcp([entry], f.root).servers).toContainEqual(
		expect.objectContaining({
			name: "plugin:review-kit:check",
			config: expect.objectContaining({ command: "different" }),
		}),
	);
});
it.each(["claude", "codex"] as const)("uses source-specific default merging for %s", (protocol) => {
	const f = fixture(protocol, { second: { command: "node" } });
	const found = inspectPluginMcp(f.entry);
	expect(found.errors).toEqual([]);
	expect(found.servers.map((server) => server.name)).toEqual(protocol === "claude" ? ["check", "second"] : ["second"]);
});
it("rejects escaping configuration symlinks and unsupported transports", () => {
	const f = fixture();
	const outside = path.join(f.root, "outside.json");
	fs.writeFileSync(outside, '{"mcpServers":{"escape":{"command":"node"}}}');
	fs.unlinkSync(path.join(f.plugin, ".mcp.json"));
	fs.symlinkSync(outside, path.join(f.plugin, ".mcp.json"));
	expect(inspectPluginMcp(f.entry).errors.join()).toContain("escapes");
	fs.unlinkSync(path.join(f.plugin, ".mcp.json"));
	fs.writeFileSync(
		path.join(f.plugin, ".mcp.json"),
		'{"mcpServers":{"ws":{"type":"ws","url":"wss://example.invalid"}}}',
	);
	expect(inspectPluginMcp(f.entry).errors.length).toBeGreaterThan(0);
	expect(loadConfiguredPluginMcp([f.entry], f.root).servers).toEqual([]);
});
it("registers enabled plugin servers through the existing resource runtime and removes them on reload", async () => {
	const f = fixture();
	const agentDir = path.join(f.root, "agent");
	fs.mkdirSync(agentDir);
	const entry = f.entry;
	const settingsFile = path.join(agentDir, "settings.json");
	fs.writeFileSync(settingsFile, JSON.stringify({ plugins: [entry] }));
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir,
	});
	await loader.reload();
	expect(loader.getFeatures().errors).toEqual([]);
	expect(
		loader
			.getFeatures()
			.runtime.mcpServers.list()
			.map((server) => server.name),
	).toContain("plugin:review-kit:check");
	fs.writeFileSync(settingsFile, JSON.stringify({ plugins: [{ ...entry, enabled: false }] }));
	await loader.reload();
	expect(loader.getFeatures().runtime.mcpServers.list()).toEqual([]);
});

it("skips plugin servers quietly when MCP is disabled", async () => {
	const f = fixture();
	const agentDir = path.join(f.root, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ plugins: [f.entry] }));
	const loader = new DefaultResourceLoader({ cwd: f.root, agentDir, disabledFeatures: ["mcp"] });
	await loader.reload();
	expect(loader.getFeatures().errors).toEqual([]);
	expect(loader.getFeatures().runtime.mcpServers.list()).toEqual([]);
});

it("connects an enabled plugin server through the MCP owner and makes it callable by hooks", async () => {
	const f = fixture();
	const agentDir = path.join(f.root, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ plugins: [f.entry] }));
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "check", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [{ name: "policy", inputSchema: { type: "object" } }] }
					: {
							content: [
								{
									type: "text",
									text: '{"decision":"block","reason":"plugin policy"}',
								},
							],
						};
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	let api!: FeatureSetup;
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir,
		features: testFeatures([
			(host) => {
				api = host;
				return createMcpFeature({
					loadConfig: () => ({ servers: [], errors: [] }),
					createTransport: () => pair.client,
				})(host);
			},
		]),
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	try {
		await harness.session.bindFeatures({});
		const result = await getMcpHookCaller(api.channels)!({
			server: "plugin:review-kit:check",
			tool: "policy",
			input: {},
			signal: new AbortController().signal,
			waitForConnection: true,
			authorize: async () => {},
		});
		expect(result.content).toEqual([{ type: "text", text: '{"decision":"block","reason":"plugin policy"}' }]);
		expect(mcpNamespace("plugin:review-kit:check")).toBe("mcp__plugin_review-kit_check");
		expect(mcpNamespace("existing-server")).toBe("mcp__existing_server");
		expect(api.tools.getAll().map((tool) => tool.name)).toContain("mcp__plugin_review-kit_check__policy");
	} finally {
		harness.cleanup();
		await pair.client.close();
		await pair.server.close();
	}
});

it("loads project plugin servers only after project settings are trusted", async () => {
	const f = fixture();
	const agentDir = path.join(f.root, "agent");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(path.join(f.root, ".octocode"));
	fs.writeFileSync(path.join(f.root, ".octocode/settings.json"), JSON.stringify({ plugins: [f.entry] }));
	const settingsManager = SettingsManager.create(f.root, agentDir);
	settingsManager.setProjectTrusted(false);
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir,
		settingsManager,
	});
	await loader.reload();
	expect(loader.getFeatures().runtime.mcpServers.list()).toEqual([]);
	settingsManager.setProjectTrusted(true);
	await loader.reload();
	expect(
		loader
			.getFeatures()
			.runtime.mcpServers.list()
			.map((server) => server.name),
	).toEqual(["plugin:review-kit:check"]);
});

it("activates reviewed plugin servers through the default built-in MCP owner", async () => {
	const f = fixture();
	vi.stubEnv("HOME", f.root);
	vi.stubEnv("OCTOCODE_HOME", path.join(f.root, "native"));
	vi.stubEnv("OCTOCODE_MCP", "0");
	const script = path.join(f.plugin, "server.mjs");
	fs.writeFileSync(
		script,
		`import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", line => {
 const m = JSON.parse(line); if (!m.method || m.id === undefined) return;
 const result = m.method === "initialize" ? { protocolVersion: ${JSON.stringify(LATEST_PROTOCOL_VERSION)}, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
 : m.method === "tools/list" ? { tools: [{ name: "policy", inputSchema: { type: "object" } }] }
 : { content: [{ type: "text", text: "built-in owner reached" }] };
 process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
	);
	fs.writeFileSync(
		path.join(f.plugin, ".mcp.json"),
		JSON.stringify({ mcpServers: { check: { command: process.execPath, args: [script] } } }),
	);
	const agentDir = path.join(f.root, "agent");
	fs.mkdirSync(agentDir);
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	const settings = SettingsManager.inMemory({
		plugins: [f.entry],
	});
	let api!: FeatureSetup;
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir,
		settingsManager: settings,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([
			(host) => {
				api = host;
			},
		]),
	});
	await loader.reload();
	expect(loader.getFeatures().features.some((feature) => feature.path === "builtin:mcp")).toBe(true);
	const harness = await createHarness({ resourceLoader: loader });
	try {
		await harness.session.bindFeatures({});
		const caller = getMcpHookCaller(api.channels);
		expect(caller).toBeTypeOf("function");
		const result = await caller!({
			server: "plugin:review-kit:check",
			tool: "policy",
			input: {},
			signal: new AbortController().signal,
			waitForConnection: true,
			authorize: async () => {},
		});
		expect(result.content).toEqual([{ type: "text", text: "built-in owner reached" }]);
	} finally {
		await harness.session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		expect(getMcpHookCaller(api.channels)).toBeUndefined();
		harness.cleanup();
	}
}, 15_000);
