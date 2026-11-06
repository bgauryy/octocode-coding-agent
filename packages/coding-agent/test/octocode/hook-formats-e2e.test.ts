import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { buildInventory, renderInventory } from "../../src/core/extensibility/inventory.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { trustFolder } from "./helpers.ts";
import { PROFILE_EVENTS, writeExtensions, writeHookFiles, writePlugins, writeSkills } from "./fixtures/hook-formats.ts";

// Hermetic: a run from inside an Octocode subagent or a customized shell would change discovery.
for (const key of ["OCTOCODE_SUBAGENT", "OCTOCODE_HOME", "OCTOCODE_AGENT_DB", "CLAUDE_CONFIG_DIR", "CODEX_HOME"])
	delete process.env[key];

/**
 * One real session that loads every supported hook, plugin, extension and skill format at once, runs a single bash
 * call through a scripted model, and checks what each source loaded and which events reached it.
 */
describe("every hook, plugin, extension and skill format in one session", () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-formats-")));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const log = path.join(root, "events.log");
	const saved = {
		home: process.env.HOME,
		agentDir: process.env.OCTOCODE_CODING_AGENT_DIR,
		permission: process.env.OCTOCODE_PERMISSION,
	};
	let hookFiles: ReturnType<typeof writeHookFiles>;
	let plugins: ReturnType<typeof writePlugins>;
	let skills: string[];
	let session: Awaited<ReturnType<typeof createTestSession>>["session"];
	let loader: DefaultResourceLoader;
	let lines: string[][] = [];

	beforeAll(async () => {
		for (const dir of [home, cwd, agentDir]) fs.mkdirSync(dir, { recursive: true });
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.writeFileSync(log, "");
		process.env.HOME = home;
		process.env.OCTOCODE_CODING_AGENT_DIR = agentDir;
		process.env.OCTOCODE_PERMISSION = "workspace";
		hookFiles = writeHookFiles(home, cwd, log);
		plugins = writePlugins(path.join(root, "plugins"), log);
		skills = writeSkills(home, cwd);
		const { packageDir } = writeExtensions(agentDir, root, log);
		// The user trusted this project folder (/trust).
		trustFolder(cwd);
		// Keep the built-in research server off; plugin servers still register.
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "false", enabled: false } } }),
		);
		// Enabling a plugin approves its hooks and MCP servers.
		const reviewed = plugins.map(({ path: pluginPath, protocol }) => ({ path: pluginPath, protocol }));

		const faux = createFauxCore({
			provider: "faux",
			models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }],
		});
		const provider: ExtensionFactory = (api) => {
			api.registerProvider("faux", {
				name: "Faux",
				api: faux.api,
				baseUrl: "http://127.0.0.1:0",
				apiKey: "test",
				models: faux.models.map((model) => ({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
				streamSimple: faux.streamSimple,
			} as never);
		};
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			plugins: reviewed,
			packages: [packageDir],
			toggles: { "harness:claude": true, "harness:codex": true },
		});
		settingsManager.setProjectTrusted(true);
		loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [{ name: "faux-provider", factory: provider }],
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		({ session } = await createTestSession({
			cwd,
			agentDir,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		}));
		await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
		await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
		faux.setResponses([
			() =>
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo formats", reason: "format check" })], {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		await session.prompt("run the format check");
		await new Promise((resolve) => setTimeout(resolve, 500)); // background observers settle
		lines = fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => line.split("\t"));
	}, 120_000);

	afterAll(async () => {
		await session?.dispose?.();
		process.env.HOME = saved.home;
		for (const [key, value] of [
			["OCTOCODE_CODING_AGENT_DIR", saved.agentDir],
			["OCTOCODE_PERMISSION", saved.permission],
		] as const)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		fs.rmSync(root, { recursive: true, force: true });
	});

	const eventsOf = (tag: string) =>
		[...new Set(lines.filter(([source]) => source === tag).map(([, event]) => event))].sort();

	it("runs every standalone hook file for each event its profile supports", () => {
		const report = Object.fromEntries(hookFiles.map(({ tag }) => [tag, eventsOf(tag)]));
		const expected = Object.fromEntries(
			hookFiles.map(({ tag, profile }) => [tag, [...PROFILE_EVENTS[profile]].sort()]),
		);
		expect(report).toEqual(expected);
	});

	it("passes the projected tool name to each profile", () => {
		const tools = (tag: string) =>
			lines.filter(([source, event]) => source === tag && event === "PreToolUse").map(([, , tool]) => tool);
		expect(tools("claude-user")).toEqual(["Bash"]);
		expect(tools("codex-user-json")).toEqual(["Bash"]);
		expect(tools("native-user")).toEqual(["Bash"]);
	});

	it("runs reviewed hooks from every plugin manifest format", () => {
		const report = Object.fromEntries(plugins.map(({ name }) => [name, eventsOf(`plugin-${name}`)]));
		const expected = Object.fromEntries(
			plugins.map(({ name, protocol }) => [name, [...PROFILE_EVENTS[protocol]].sort()]),
		);
		expect(report).toEqual(expected);
	});

	it("loads plugin skills and Claude prompt commands under the plugin namespace", () => {
		const names = loader.getSkills().skills.map((skill) => skill.name);
		for (const { name } of plugins) expect(names).toContain(`${name}:hello`);
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("claude-kit:greet");
	});

	it("warns about plugin components Octocode does not load", () => {
		const warnings = loader
			.getSkills()
			.diagnostics.filter((diagnostic) => diagnostic.type === "warning")
			.map((diagnostic) => diagnostic.message);
		expect(warnings).toContain("claude-kit: not loaded by Octocode yet: lspServers");
		expect(warnings).toContain("codex-kit: not loaded by Octocode yet: apps");
		expect(warnings.some((message) => message.startsWith("portable-kit:"))).toBe(false);
	});

	it("lists every plugin, extension and hook per host in the /harness inventory", async () => {
		const settings = session.settingsManager.getSettings();
		// This SDK session keeps its settings in memory; the CLI resolves packages from the same files it loaded.
		const manager = SettingsManager.inMemory(settings);
		const inventory = await buildInventory({ cwd, agentDir, settings, manager, projectTrusted: true, home });
		const text = renderInventory(inventory);
		const hosts = Object.fromEntries(
			["claude", "codex", "octocode", "packages"].map((host) => [
				host,
				inventory.items.filter((item) => item.host === host).map((item) => item.kind),
			]),
		);
		expect(hosts.claude).toEqual(expect.arrayContaining(["hooks", "hook-file", "hook", "plugin"]));
		expect(hosts.codex).toEqual(expect.arrayContaining(["hooks", "hook-file", "hook", "plugin"]));
		expect(hosts.octocode).toEqual(expect.arrayContaining(["hooks", "hook-file", "hook", "extension"]));
		expect(hosts.packages).toContain("extension");
		// Every hook file the session ran (nine standalone, one per plugin) appears once.
		expect(inventory.items.filter((item) => item.kind === "hook-file").length).toBe(hookFiles.length + plugins.length);
		expect(text).toContain("claude-kit (plugin, claude manifest)");
		expect(text).toMatch(/claude-kit[^\n]*hooks loads[^\n]*not loaded: lspServers/);
		expect(text).toContain("portable-kit (plugin, portable manifest)");
		const harnesses = inventory.items.filter((item) => item.id.startsWith("harness:"));
		expect(harnesses.filter((item) => item.on).map((item) => item.id)).toEqual(
			expect.arrayContaining(["harness:claude", "harness:codex"]),
		);
		expect(inventory.items.filter((item) => !harnesses.includes(item)).every((item) => item.on)).toBe(true);
		expect(inventory.stale).toEqual([]);
	});

	it("registers reviewed plugin MCP servers", () => {
		const { runtime } = loader.getExtensions();
		for (const { name } of plugins) expect(runtime.mcpServers.get(`plugin:${name}:echo`), name).toBeDefined();
	});

	it("lists but never runs code extensions in the extensions folder and in a local package", () => {
		// User code extensions are removed: the files are reported as ignored and no handler of theirs reached an event.
		expect(eventsOf("extension-dir")).toEqual([]);
		expect(eventsOf("package")).toEqual([]);
		const warnings = loader.getExtensions().warnings ?? [];
		expect(warnings.length).toBeGreaterThan(0);
		for (const warning of warnings) expect(warning.warning).toMatch(/^Ignored extension\b.*not supported/);
	});

	it("discovers skills from Octocode, Agent Skills, Claude and Codex folders", () => {
		const names = loader.getSkills().skills.map((skill) => skill.name);
		expect(skills.filter((name) => !names.includes(name))).toEqual([]);
	});
});
