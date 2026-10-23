import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	inspectPluginMcp,
	loadConfiguredPluginMcp,
} from "../src/core/plugin-mcp.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { getMcpHookCaller } from "../src/extensions/mcp/hook-caller.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createInMemoryTransportPair } from "@octocodeai/octocode-mcp/testing";
import { LATEST_PROTOCOL_VERSION } from "@octocodeai/octocode-mcp";
import { mcpNamespace } from "../src/core/mcp-servers.ts";
import { createHarness } from "./suite/harness.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fixture(
	protocol: "claude" | "codex" = "claude",
	declarations?: unknown,
) {
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
it("requires independent MCP review, expands plugin paths and invalidates approval on changes", () => {
	const f = fixture();
	const inspection = inspectPluginMcp(f.entry);
	expect(inspection.errors).toEqual([]);
	expect(inspection.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	expect(loadConfiguredPluginMcp([f.entry], f.root).servers).toEqual([]);
	const entry = { ...f.entry, mcpFingerprint: inspection.fingerprint };
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
	expect(loadConfiguredPluginMcp([entry], f.root).servers).toEqual([]);
});
it.each(["claude", "codex"] as const)(
	"uses source-specific default merging for %s",
	(protocol) => {
		const f = fixture(protocol, { second: { command: "node" } });
		const found = inspectPluginMcp(f.entry);
		expect(found.errors).toEqual([]);
		expect(found.servers.map((server) => server.name)).toEqual(
			protocol === "claude" ? ["check", "second"] : ["second"],
		);
	},
);
it("rejects escaping configuration symlinks and unsupported transports before approval", () => {
	const f = fixture();
	const outside = path.join(f.root, "outside.json");
	fs.writeFileSync(outside, '{"mcpServers":{"escape":{"command":"node"}}}');
	fs.unlinkSync(path.join(f.plugin, ".mcp.json"));
	fs.symlinkSync(outside, path.join(f.plugin, ".mcp.json"));
	expect(inspectPluginMcp(f.entry).fingerprint).toBeUndefined();
	expect(inspectPluginMcp(f.entry).errors.join()).toContain("escapes");
	fs.unlinkSync(path.join(f.plugin, ".mcp.json"));
	fs.writeFileSync(
		path.join(f.plugin, ".mcp.json"),
		'{"mcpServers":{"ws":{"type":"ws","url":"wss://example.invalid"}}}',
	);
	expect(inspectPluginMcp(f.entry).fingerprint).toBeUndefined();
});
it("registers reviewed plugin servers through the existing resource runtime and removes them on reload", async () => {
	const f = fixture();
	const agentDir = path.join(f.root, "agent");
	fs.mkdirSync(agentDir);
	const entry = {
		...f.entry,
		mcpFingerprint: inspectPluginMcp(f.entry).fingerprint,
	};
	const settingsFile = path.join(agentDir, "settings.json");
	fs.writeFileSync(settingsFile, JSON.stringify({ plugins: [entry] }));
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir,
		nativeFeatures: false,
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	expect(
		loader
			.getExtensions()
			.runtime.mcpServers.list()
			.map((server) => server.name),
	).toContain("plugin:review-kit:check");
	fs.writeFileSync(
		settingsFile,
		JSON.stringify({ plugins: [{ ...entry, enabled: false }] }),
	);
	await loader.reload();
	expect(loader.getExtensions().runtime.mcpServers.list()).toEqual([]);
});

it("connects a reviewed plugin server through the MCP owner and makes it callable by hooks", async () => {
	const f = fixture();
	const agentDir = path.join(f.root, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			plugins: [
				{ ...f.entry, mcpFingerprint: inspectPluginMcp(f.entry).fingerprint },
			],
		}),
	);
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
	let api!: ExtensionAPI;
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir,
		nativeFeatures: false,
		extensionFactories: [
			(pi) => {
				api = pi;
				return createMcpExtension({
					loadConfig: () => ({ servers: [], errors: [] }),
					createTransport: () => pair.client,
				})(pi);
			},
		],
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	try {
		await harness.session.bindExtensions({});
		const result = await getMcpHookCaller(api.events)!({
			server: "plugin:review-kit:check",
			tool: "policy",
			input: {},
			signal: new AbortController().signal,
			waitForConnection: true,
		});
		expect(result.content).toEqual([
			{ type: "text", text: '{"decision":"block","reason":"plugin policy"}' },
		]);
		expect(mcpNamespace("plugin:review-kit:check")).toBe(
			"mcp__plugin_review-kit_check",
		);
		expect(mcpNamespace("existing-server")).toBe("mcp__existing_server");
		expect(api.getAllTools().map(tool => tool.name)).toContain("mcp__plugin_review-kit_check__policy");
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
	fs.writeFileSync(
		path.join(f.root, ".octocode/settings.json"),
		JSON.stringify({
			plugins: [
				{ ...f.entry, mcpFingerprint: inspectPluginMcp(f.entry).fingerprint },
			],
		}),
	);
	const settingsManager = SettingsManager.create(f.root, agentDir);
	settingsManager.setProjectTrusted(false);
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir,
		settingsManager,
		nativeFeatures: false,
	});
	await loader.reload();
	expect(loader.getExtensions().runtime.mcpServers.list()).toEqual([]);
	settingsManager.setProjectTrusted(true);
	await loader.reload();
	expect(
		loader
			.getExtensions()
			.runtime.mcpServers.list()
			.map((server) => server.name),
	).toEqual(["plugin:review-kit:check"]);
});

it("activates reviewed plugin servers through the default built-in MCP owner", async () => {
	const f = fixture();
	vi.stubEnv("HOME", f.root);
	vi.stubEnv("OCTOCODE_HOME", path.join(f.root, "native"));
	vi.stubEnv("OCTOCODE_MCP", "0");
	vi.stubEnv("OCTOCODE_NO_LOCAL_LLM", "1");
	const script = path.join(f.plugin, "server.mjs");
	fs.writeFileSync(script, `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", line => {
 const m = JSON.parse(line); if (!m.method || m.id === undefined) return;
 const result = m.method === "initialize" ? { protocolVersion: ${JSON.stringify(LATEST_PROTOCOL_VERSION)}, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
 : m.method === "tools/list" ? { tools: [{ name: "policy", inputSchema: { type: "object" } }] }
 : { content: [{ type: "text", text: "built-in owner reached" }] };
 process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`);
	fs.writeFileSync(path.join(f.plugin, ".mcp.json"), JSON.stringify({ mcpServers: { check: { command: process.execPath, args: [script] } } }));
	const agentDir = path.join(f.root, "agent");fs.mkdirSync(agentDir);
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	const settings = SettingsManager.inMemory({ plugins: [{ ...f.entry, mcpFingerprint: inspectPluginMcp(f.entry).fingerprint }] });
	let api!: ExtensionAPI;
	const loader = new DefaultResourceLoader({ cwd: f.root, agentDir, settingsManager: settings,
		extensionFactories: [pi => { api = pi; }],
	});
	await loader.reload();
	expect(loader.getExtensions().extensions.some(extension => extension.path === "builtin:mcp")).toBe(true);
	const harness = await createHarness({ resourceLoader: loader });
	try {
		await harness.session.bindExtensions({});
		const caller = getMcpHookCaller(api.events);expect(caller).toBeTypeOf("function");
		const result = await caller!({ server: "plugin:review-kit:check", tool: "policy", input: {}, signal: new AbortController().signal, waitForConnection: true });
		expect(result.content).toEqual([{ type: "text", text: "built-in owner reached" }]);
	} finally {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(getMcpHookCaller(api.events)).toBeUndefined();
		harness.cleanup();
	}
}, 15_000);
