import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildInventory, type InventoryItem, renderInventory } from "../../src/octocode/harness/inventory.ts";
import { switchItem } from "../../src/core/extensibility/switch.ts";
import { effectivePlugins, isSwitchedOn, pluginToggleId } from "../../src/core/extensibility/toggles.ts";
import type { Settings } from "../../src/core/settings-schema.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { mergeScopedSettings } from "../../src/core/settings-manager/merge.ts";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { hookToggleIds } from "../../src/octocode/hooks/config/toggles.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { getMcpSwitch, type McpSwitchRequest, registerMcpSwitch } from "../../../mcp/src/switch.ts";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import { registerHarnessCommand } from "../../src/octocode/harness/command.ts";
import type { HooksView } from "../../src/octocode/hooks/register/types.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { writeHookFiles } from "./fixtures/hook-formats.ts";
import { tmp } from "./helpers.ts";
import { installMcpCorePorts } from "../../src/octocode/mcp-host/core.ts";
import { createConfiguration, type ConfigLiveHooks } from "../../src/configuration/index.ts";
import { installOctocodeDiscovery } from "../../src/octocode/discovery/index.ts";

beforeAll(() => {
	installMcpCorePorts();
	installOctocodeDiscovery();
});

afterEach(() => vi.unstubAllEnvs());

function fixture() {
	const home = fs.realpathSync(tmp());
	const cwd = fs.realpathSync(tmp());
	const agentDir = path.join(home, "agent");
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(agentDir);
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", path.join(home, ".octocode/octocodecode"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	writeHookFiles(home, cwd, path.join(home, "events.log"));
	return { home, cwd, agentDir };
}

/** The hook tags (from `writeHookFiles`) that load under `toggles`. */
const loadedTags = (f: ReturnType<typeof fixture>, toggles: Record<string, boolean>) => {
	const { config } = loadHooks(f.cwd, true, f.home, { toggles });
	return [
		...new Set(
			config.PreToolUse.flatMap((group) =>
				group.hooks.map((hook) => (hook as { command: string }).command.split(" ").at(-1) ?? ""),
			),
		),
	].sort();
};

describe("toggles", () => {
	it("keep project keys scoped after the merge, and the most specific key wins", () => {
		const merged = mergeScopedSettings({ toggles: { a: false, b: false } }, { toggles: { a: true } }).toggles;
		expect(merged).toEqual({ a: false, b: false, "project:a": true });
		expect(isSwitchedOn(["a"], merged, true)).toBe(true);
		expect(isSwitchedOn(["a"], merged, false)).toBe(false);
		expect(isSwitchedOn(["c", "b"], merged, false)).toBe(false);
		expect(isSwitchedOn(["c", "b"], { ...merged, c: true }, false)).toBe(true);
	});

	it("switch hooks off by host and back on one by one", () => {
		const f = fixture();
		expect(loadedTags(f, {})).toEqual(["native-project", "native-user"]);
		const on = { "harness:claude": true, "harness:codex": true };
		const all = loadedTags(f, on);
		expect(all).toHaveLength(9);
		expect(loadedTags(f, { "hooks:claude": true, "hooks:codex": true })).toEqual(all);
		const withoutClaude = loadedTags(f, { ...on, "hooks:claude": false });
		expect(withoutClaude).toEqual(all.filter((tag) => !tag.startsWith("claude-")));
		const { config } = loadHooks(f.cwd, true, f.home);
		const group = config.PreToolUse.find((candidate) =>
			candidate.hooks.some(
				(hook) => hook.source.endsWith(path.join(".claude", "settings.json")) && !hook.source.startsWith(f.cwd),
			),
		)!;
		const [hookId] = hookToggleIds("PreToolUse", group.matcher, group.hooks[0], f.home);
		expect(loadedTags(f, { ...on, "hooks:claude": false, [hookId]: true })).toEqual(
			[...withoutClaude, "claude-user"].sort(),
		);
		const { errors, switchedOff } = loadHooks(f.cwd, true, f.home, { toggles: { ...on, "hooks:claude": false } });
		expect(errors.join("\n")).not.toMatch(/switched off/);
		expect(switchedOff).toBeGreaterThanOrEqual(all.filter((tag) => tag.startsWith("claude-")).length);
	});

	it("let a project switch only the repository's own hooks", () => {
		const f = fixture();
		const toggles = mergeScopedSettings(
			{ toggles: { "harness:claude": true, "harness:codex": true } },
			{ toggles: { "hooks:claude": false, "hooks:codex": false } },
		).toggles!;
		const tags = loadedTags(f, toggles);
		expect(tags).toContain("claude-user");
		expect(tags).toContain("codex-user-json");
		expect(tags).not.toContain("claude-project");
		expect(tags).not.toContain("claude-local");
		expect(tags).not.toContain("codex-project-json");
	});

	it("resolve plugin entries for every plugin loader", () => {
		const f = fixture();
		const inside = path.join(f.cwd, "kit");
		const outside = path.join(f.home, "kit");
		const plugins = [inside, outside].map((dir) => ({ path: dir, protocol: "claude" as const }));
		const project = mergeScopedSettings(
			{ plugins },
			{ toggles: { [pluginToggleId(inside)]: false, [pluginToggleId(outside)]: false } },
		);
		expect(effectivePlugins(project, f.cwd)?.map((entry) => entry.enabled)).toEqual([false, undefined]);
		const global = mergeScopedSettings({ plugins, toggles: { [pluginToggleId(outside)]: false } }, {});
		expect(effectivePlugins(global, f.cwd)?.map((entry) => entry.enabled)).toEqual([undefined, false]);
	});
});

describe("switchItem", () => {
	const hookItem = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
		id: "hook:abc",
		host: "claude",
		kind: "hook",
		label: "PreToolUse [Bash] guard",
		depth: 2,
		on: true,
		detail: "",
		parents: ["hooks:claude:~/.claude/settings.json", "hooks:claude"],
		...overrides,
	});

	it("writes only real exceptions to the chosen scope", async () => {
		const f = fixture();
		const manager = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
		switchItem(hookItem(), false, "global", manager, f);
		await manager.flush();
		expect(manager.getGlobalSettings().toggles).toEqual({ "hook:abc": false });
		switchItem(hookItem(), true, "global", manager, f);
		manager.setToggle("global", "hooks:claude", false);
		switchItem(hookItem(), true, "global", manager, f);
		await manager.flush();
		// On under a host switched off needs an explicit key; on under nothing off needs none.
		expect(JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toggles).toEqual({
			"hooks:claude": false,
			"hook:abc": true,
		});
	});

	it("refuses what the rules do not allow", () => {
		const f = fixture();
		const trusted = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
		const untrusted = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: false });
		expect(() => switchItem(hookItem(), false, "project", untrusted, f)).toThrow("/trust");
		expect(() => switchItem(hookItem(), false, "project", trusted, f)).toThrow("not part of this repository");
		expect(() => switchItem(hookItem({ gate: true }), false, "global", trusted, f)).toThrow("--force");
		expect(() =>
			switchItem(hookItem({ locked: "trust this project first (/trust)" }), true, "global", trusted, f),
		).toThrow("/trust");
		expect(() => switchItem(hookItem({ project: true }), false, "project", trusted, f)).not.toThrow();
		expect(() => switchItem(hookItem({ gate: true }), false, "global", trusted, { ...f, force: true })).not.toThrow();
	});

	it("switches extensions through the patterns octocode config writes", async () => {
		const f = fixture();
		const manager = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
		const file = path.join(f.agentDir, "extensions", "record.ts");
		switchItem(
			hookItem({
				id: "extension:record",
				kind: "extension",
				host: "octocode",
				parents: undefined,
				resource: {
					path: file,
					enabled: true,
					metadata: { source: "local", scope: "user", origin: "top-level", baseDir: f.agentDir },
					resourceType: "extensions",
					displayName: "record.ts",
					groupKey: "user",
					subgroupKey: "extensions",
				},
			}),
			false,
			"global",
			manager,
			f,
		);
		await manager.flush();
		expect(manager.getGlobalSettings().extensions).toEqual(["-extensions/record.ts"]);
	});
});

/** The catalog `/configuration` runs on, over the fixture's own settings files. */
function catalogFor(f: ReturnType<typeof fixture>, live?: ConfigLiveHooks) {
	return createConfiguration({
		cwd: f.cwd,
		agentDir: f.agentDir,
		home: f.home,
		projectTrusted: true,
		settings: SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true }),
		...(live ? { live } : {}),
	});
}

/** `/harness` as the session registers it, with a hooks view that only reports. */
function harness(api: ExtensionAPI) {
	const commands = new Subcommands();
	registerHarnessCommand(commands, { report: () => "Hooks: on" } as unknown as HooksView, api);
	return commands.get("harness")!;
}

describe("/harness", () => {
	it("lists every hook per host and switches one by ID", async () => {
		const f = fixture();
		const { api } = fakeHost();
		const command = harness(api);
		const ctx = fakeCtx({ cwd: f.cwd, mode: "rpc" });
		await command.handler("", ctx);
		const listing = ctx.ui.notes.at(-1)!.message;
		for (const title of ["Claude Code", "Codex", "Octocode"]) expect(listing).toContain(title);
		// Claude Code is off by default, so its hooks list as off.
		expect(listing).toContain("[ ] Hooks from Claude Code");
		const on = { toggles: { "harness:claude": true } };
		fs.writeFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify(on));
		Object.assign(api, { getSettings: () => on });
		await command.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("[x] Hooks from Claude Code");
		const catalog = catalogFor(f);
		const off = await catalog.apply({ verb: "disable", id: "hooks:claude" });
		expect(off).toMatchObject({ status: "applied", appliesWhen: "reload" });
		expect(JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toggles).toEqual({
			"harness:claude": true,
			"hooks:claude": false,
		});
		// Switched on again before a reload: the saved switch is reverted, not skipped because the session still has it on.
		await catalog.apply({ verb: "enable", id: "hooks:claude" });
		expect(JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toggles).toEqual({
			"harness:claude": true,
		});
		const unknown = await catalog.apply({ verb: "disable", id: "nothing:here" });
		expect(unknown.status).toBe("refused");
		// The retired verb names the line that replaces it; a bare name resolves through the catalog when it is unique.
		await command.handler("disable hooks:claude", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({ type: "warning" });
		expect(ctx.ui.notes.at(-1)!.message).toContain("/configuration disable hooks:claude");
		await command.handler("enable claude --local", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("/configuration enable harness:claude --local");
		await command.handler("disable no-such-name", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/"no-such-name" needs an id[\s\S]*\/configuration list <name>/);
	});

	it("lists one section, filters by text, and reports hooks and config through subcommands", async () => {
		const f = fixture();
		const { api } = fakeHost();
		const command = harness(api);
		const ctx = fakeCtx({ cwd: f.cwd, mode: "rpc" });
		await command.handler("list hooks", ctx);
		const hooks = ctx.ui.notes.at(-1)!.message;
		expect(hooks).toContain("Hooks from Claude Code");
		await command.handler("list mcp", ctx);
		expect(ctx.ui.notes.at(-1)!.message).not.toContain("Hooks from Claude Code");
		await command.handler("list codex", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("Codex");
		await command.handler("hooks", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toBe("Hooks: on");
		await command.handler("hooks events", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("Hook events Octocode implements");
		await command.handler("bogus", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({ type: "warning" });
		expect(ctx.ui.notes.at(-1)!.message).toContain("/harness list");
	});

	it("switches MCP servers by name through the MCP owner, live and without a reload", async () => {
		const f = fixture();
		const { api } = fakeHost();
		const events = createEventBus();
		Object.assign(api, { events });
		const requests: McpSwitchRequest[] = [];
		setMcpSessionStatus(events, [
			{ name: "docs", enabled: true, state: "connected", source: path.join(f.agentDir, "mcp.json"), tools: [] },
		] as never);
		registerMcpSwitch(events, async (request) => {
			requests.push(request);
			return { ok: true, message: `${request.name}: ${request.enabled ? "enabled" : "disabled"}` };
		});
		fs.writeFileSync(
			path.join(f.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }),
		);
		const reload = vi.fn(async () => {});
		const ctx = Object.assign(fakeCtx({ cwd: f.cwd, mode: "rpc" }), { reload });
		const command = harness(api);
		await command.handler("list mcp", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("docs");
		const catalog = catalogFor(f, { mcpSwitch: getMcpSwitch(events)! });
		const result = await catalog.apply({ verb: "disable", id: "mcp:docs", scope: "project" });
		expect(requests).toEqual([{ name: "docs", enabled: false, inProject: true }]);
		expect(result).toMatchObject({ status: "applied", appliesWhen: "now" });
		expect(reload).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(f.agentDir, "settings.json"))).toBe(false);
	});

	it("switches a hook group and an MCP server in one go: the server closes live once, the hook change waits for a reload, and a repeat changes no file", async () => {
		const f = fixture();
		const events = createEventBus();
		const requests: McpSwitchRequest[] = [];
		setMcpSessionStatus(events, [
			{ name: "docs", enabled: true, state: "connected", source: path.join(f.agentDir, "mcp.json"), tools: [] },
		] as never);
		registerMcpSwitch(events, async (request) => {
			requests.push(request);
			return { ok: true, message: `${request.name}: disabled` };
		});
		fs.writeFileSync(
			path.join(f.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }),
		);
		const catalog = catalogFor(f, { mcpSwitch: getMcpSwitch(events)! });
		const results = await Promise.all([
			catalog.apply({ verb: "disable", id: "hooks:claude" }),
			catalog.apply({ verb: "disable", id: "mcp:docs" }),
		]);
		expect(requests).toEqual([{ name: "docs", enabled: false, inProject: false }]);
		expect(
			results
				.map((result) => result.status === "applied" && result.appliesWhen)
				.sort((a, b) => String(a).localeCompare(String(b))),
		).toEqual(["now", "reload"]);
		const settingsFile = path.join(f.agentDir, "settings.json");
		const saved = fs.readFileSync(settingsFile, "utf8");
		// The same switch again leaves the settings file as it was.
		await catalog.apply({ verb: "disable", id: "hooks:claude" });
		expect(fs.readFileSync(settingsFile, "utf8")).toBe(saved);
	});

	it("answers the retired /plugins, /hooks and /config over RPC with the /harness line to run", async () => {
		const { api, fire } = fakeHost();
		Object.assign(api, { getCommands: () => [{ name: "harness" }] });
		const commands = new Subcommands();
		registerHarnessCommand(commands, { report: () => "" } as unknown as HooksView, api);
		commands.register(api);
		const ctx = fakeCtx({ cwd: tmp(), mode: "rpc" });
		expect(await fire("input", { text: "/plugins disable hooks:claude" }, ctx)).toEqual({ action: "handled" });
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			message: "/plugins moved to /harness. Run /harness disable hooks:claude to continue.",
			type: "warning",
		});
		await fire("input", { text: "/hooks events" }, ctx);
		expect(ctx.ui.notes.at(-1)!.message).toBe("/hooks moved to /harness hooks. Run /harness hooks events to continue.");
		expect(await fire("input", { text: "/configure" }, ctx)).toEqual({ action: "continue" });
	});
});

describe("/harness terminal list", () => {
	it("toggles with Space or Enter, guards gates, explains blocked rows, filters, and offers a reload", async () => {
		const f = fixture();
		// Claude Code switched on, so its hook rows can be switched one by one.
		const on = { toggles: { "harness:claude": true } };
		fs.writeFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify(on));
		// A required gate in the native user file.
		fs.writeFileSync(
			path.join(f.home, ".octocode/octocodecode/hooks.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "guard", failClosed: true }] }] } }),
		);
		let component: { handleInput(data: string): void; render(width: number): string[] } | undefined;
		let closed: Promise<unknown> | undefined;
		const custom = (factory: (...args: unknown[]) => typeof component) =>
			(closed = new Promise((resolve) => {
				component = factory(
					{ requestRender: () => {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					// No definitions: hints fall back to the default keys.
					{ matches: (data: string, id: string) => data === id, getDefinition: () => undefined, getKeys: () => [] },
					resolve,
				);
			}));
		initTheme("dark", false);
		const reload = vi.fn(async () => {});
		const { api } = fakeHost();
		Object.assign(api, { getSettings: () => on });
		const ctx = Object.assign(fakeCtx({ cwd: f.cwd, mode: "tui", ui: { custom, selects: ["Reload"] } }), { reload });
		const run = harness(api).handler("", ctx);
		await vi.waitFor(() => expect(component).toBeDefined());
		const press = (...keys: string[]) => keys.forEach((key) => component!.handleInput(key));
		const screen = () => component!.render(200).join("\n");
		expect(screen()).toContain("(global)");
		expect(screen()).toMatch(/Harnesses\n> +\[-\] Octocode/);
		expect(screen()).toMatch(/\[x\] Claude Code  default off\n +\[ \] Claude Code auto memory  default off/);
		for (let index = 0; index < 8; index++) press("tui.select.down");
		expect(screen()).toMatch(/Claude Code\n> +\[x\] Hooks from Claude Code/);
		// Hook files start collapsed: one row per file, not per hook.
		expect(screen()).toContain("▸ [x] ~/.claude/settings.json");
		expect(screen()).not.toContain("PreToolUse [*]");

		// Space switches the selected row; the confirmation names the scope.
		press(" ");
		expect(screen()).toContain("Hooks from Claude Code switched off globally.");
		expect(screen()).toMatch(/> +\[ \] Hooks from Claude Code/);

		// Project scope cannot reach a user hook file, and says what to do instead.
		press("tui.select.down", "tui.input.tab", " ");
		expect(screen()).toContain("(project)");
		expect(screen()).toContain("~/.claude/settings.json: not part of this repository: switch it globally.");
		press("tui.input.tab");

		// → opens the native user file; a gate hook needs a second press; Enter works like Space.
		const selected = () => component!.render(200).find((line) => line.startsWith(">") && /\[[x -]\]/.test(line));
		const moveTo = (text: string) => {
			for (let step = 0; step < 60 && !selected()?.includes(text); step++) press("tui.select.down");
		};
		moveTo("octocode/octocodecode/hooks.json");
		press("\x1b[C");
		expect(screen()).toContain("▾ [x] ~/.octocode/octocodecode/hooks.json");
		moveTo("guard");
		expect(screen()).toMatch(/> +\[x\] PreToolUse \[\*\] guard  gate/);
		press("tui.select.confirm");
		expect(screen()).toContain("Press again to switch it off.");
		press("tui.select.confirm");
		expect(screen()).toMatch(/guard switched off globally/);

		// Typing filters; a filter with no match says so instead of showing an empty list.
		press("z", "z", "z");
		expect(screen()).toContain("Nothing matches the filter.");

		press("tui.select.cancel");
		await closed;
		await run;
		expect(reload).toHaveBeenCalledOnce();
		const toggles = JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toggles;
		expect(toggles["hooks:claude"]).toBe(false);
		expect(Object.entries(toggles).filter(([id, on]) => id.startsWith("hook:") && on === false)).toHaveLength(1);
	});
});

describe("plugins installed by other hosts", () => {
	it("are listed without running anything and added to Octocode by switching them on", async () => {
		const f = fixture();
		const claudeKit = path.join(f.home, ".claude/plugins/cache/mkt/review-kit/1.0.0");
		fs.mkdirSync(path.join(claudeKit, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(path.join(claudeKit, ".claude-plugin/plugin.json"), JSON.stringify({ name: "review-kit" }));
		fs.writeFileSync(
			path.join(f.home, ".claude/plugins/installed_plugins.json"),
			JSON.stringify({ version: 2, plugins: { "review-kit@mkt": [{ scope: "user", installPath: claudeKit }] } }),
		);
		const claudeSettings = path.join(f.home, ".claude/settings.json");
		fs.writeFileSync(
			claudeSettings,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(claudeSettings, "utf8")),
				enabledPlugins: { "review-kit@mkt": true },
			}),
		);
		// Codex caches a plugin that ships only a Claude manifest.
		const codexKit = path.join(f.home, ".codex/plugins/cache/openai/browser/local");
		fs.mkdirSync(path.join(codexKit, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(path.join(codexKit, ".claude-plugin/plugin.json"), JSON.stringify({ name: "browser" }));
		fs.appendFileSync(path.join(f.home, ".codex/config.toml"), '\n[plugins."browser@openai"]\nenabled = false\n');

		const { api } = fakeHost();
		const command = harness(api);
		const ctx = fakeCtx({ cwd: f.cwd, mode: "rpc" });
		await command.handler("", ctx);
		const listing = ctx.ui.notes.at(-1)!.message;
		expect(listing).toContain(`[ ] review-kit@mkt (installed in Claude Code) — enabled there`);
		expect(listing).toContain(`installed:${claudeKit}`);
		expect(listing).toContain("browser@openai (installed in Codex) — disabled there");
		const added = await catalogFor(f).apply({ verb: "enable", id: `installed:${codexKit}` });
		expect(added).toMatchObject({ status: "applied" });
		const settings = JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"));
		expect(settings.plugins).toEqual([{ path: codexKit, protocol: "claude" }]);
	});
});

describe("plugin rows", () => {
	it("count the skills that load, not the folders declared, and name MCP servers their hooks call that nothing provides", async () => {
		const f = fixture();
		const write = (file: string, value: unknown) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
		};
		const mcpHook = (server: string) => ({ type: "mcp_tool", server, tool: "turn_ended" });
		// Like Codex's bundled browser plugin: an empty skills folder and hooks for a server only Codex runs.
		const empty = path.join(f.home, "plugins/empty-kit");
		fs.mkdirSync(path.join(empty, "skills"), { recursive: true });
		write(path.join(empty, ".codex-plugin/plugin.json"), {
			name: "empty-kit",
			skills: "./skills/",
			hooks: {
				hooks: { Stop: [{ hooks: [mcpHook("node_repl"), mcpHook("octocode"), mcpHook("plugin:empty-kit:echo")] }] },
			},
		});
		write(path.join(empty, ".mcp.json"), { mcpServers: { echo: { command: "node" } } });
		const full = path.join(f.home, "plugins/full-kit");
		write(path.join(full, ".codex-plugin/plugin.json"), { name: "full-kit", skills: "./skills/" });
		write(path.join(full, "skills/hello/SKILL.md"), "---\nname: hello\ndescription: Says hello.\n---\nSay hello.\n");

		const settings = {
			plugins: [
				{ path: empty, protocol: "codex" as const },
				{ path: full, protocol: "codex" as const, enabled: false },
			],
		};
		const octocode = { name: "octocode", enabled: true, state: "connected", toolCount: 1, exposure: "all", source: "" };
		const inventory = await buildInventory({
			cwd: f.cwd,
			agentDir: f.agentDir,
			settings,
			manager: SettingsManager.inMemory(settings),
			projectTrusted: true,
			mcp: [octocode],
			home: f.home,
		});
		const row = (name: string) =>
			renderInventory(inventory)
				.split("\n")
				.find((line) => line.includes(`${name} (plugin`));

		expect(row("empty-kit")).toContain("0 skills in 1 skill directory, 0 command sources");
		// The registered `octocode` server and the plugin's own scoped server are provided; only `node_repl` is missing.
		expect(row("empty-kit")).toContain("hooks call MCP servers no one provides: node_repl ·");
		// A switched-off plugin still shows what it would load.
		expect(row("full-kit")).toContain("1 skill in 1 skill directory");
		expect(row("full-kit")).not.toContain("no one provides");
	});

	it("leads each MCP row with its group, as skill rows name their folder", async () => {
		const f = fixture();
		const settings = {};
		const server = (name: string, scope: string, group: string, source: string) => ({
			name,
			enabled: true,
			state: "connected",
			toolCount: 2,
			exposure: "direct",
			scope,
			group,
			source,
		});
		const inventory = await buildInventory({
			cwd: f.cwd,
			agentDir: f.agentDir,
			settings,
			manager: SettingsManager.inMemory(settings),
			projectTrusted: true,
			home: f.home,
			mcp: [
				server("browser", "default", "core", "built-in browser"),
				server("tracker", "project", "workspace", path.join(f.cwd, ".mcp.json")),
				server("search", "global", "global", path.join(f.home, ".octocode/mcp.json")),
				server("kit", "extension", "global", path.join(f.home, "plugins/kit")),
			],
		});
		const detail = (name: string) => inventory.items.find((item) => item.id === `mcp:${name}`)?.detail;
		expect(detail("browser")).toBe("Core · connected · 2 tools · direct · built in");
		expect(detail("tracker")).toMatch(/^Workspace · connected · 2 tools · direct · .*\.mcp\.json$/);
		expect(detail("search")).toBe("Global · connected · 2 tools · direct · ~/.octocode/mcp.json");
		expect(detail("kit")).toBe("Global · connected · 2 tools · direct · plugin ~/plugins/kit");
	});

	const writeJson = (file: string, value: unknown) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(value));
	};
	async function rows(f: ReturnType<typeof fixture>, settings: Settings) {
		vi.stubEnv("CODEX_HOME", "");
		const inventory = await buildInventory({
			cwd: f.cwd,
			agentDir: f.agentDir,
			settings,
			manager: SettingsManager.inMemory(settings),
			projectTrusted: true,
			home: f.home,
		});
		return { inventory, text: renderInventory(inventory).split("\n") };
	}

	it("say how many of a plugin's hooks the host switches left on, while the row keeps the plugin's own switch", async () => {
		const f = fixture();
		const kit = path.join(f.home, "plugins/hook-kit");
		const command = (tag: string) => ({ type: "command", command: `echo ${tag}` });
		writeJson(path.join(kit, ".codex-plugin/plugin.json"), {
			name: "hook-kit",
			hooks: { hooks: { Stop: [{ hooks: [command("a"), command("b"), command("c")] }] } },
		});
		const plugins = [{ path: kit, protocol: "codex" as const }];
		const row = async (toggles?: Record<string, boolean>) =>
			(await rows(f, { plugins, ...(toggles ? { toggles } : {}) })).text.find((line) =>
				line.includes("hook-kit (plugin"),
			)!;

		expect(await row()).toContain("hooks loads");
		const off = await row({ "hooks:codex": false });
		expect(off).toContain("[x] hook-kit (plugin");
		expect(off).toContain("hooks 0 of 3 on (hooks:codex off)");
		// One hook switched back on by its own ID (the same IDs the hook rows list).
		const { config } = loadHooks(f.cwd, true, f.home, { plugins });
		const group = config.Stop.find((candidate) => candidate.hooks[0].plugin)!;
		const [hookId] = hookToggleIds("Stop", group.matcher, group.hooks[0], f.home);
		expect(await row({ "hooks:codex": false, [hookId]: true })).toContain("hooks 1 of 3 on (hooks:codex off)");
	});

	it("name the scoped server when a plugin hook uses the bare key of the plugin's own MCP server", async () => {
		const f = fixture();
		const kit = path.join(f.home, "plugins/bare-kit");
		writeJson(path.join(kit, ".codex-plugin/plugin.json"), {
			name: "bare-kit",
			hooks: {
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "mcp_tool", server: "echo", tool: "t" },
								{ type: "mcp_tool", server: "elsewhere", tool: "t" },
								{ type: "mcp_tool", server: "plugin:bare-kit:echo", tool: "t" },
							],
						},
					],
				},
			},
		});
		writeJson(path.join(kit, ".mcp.json"), { mcpServers: { echo: { command: "node" } } });
		const { text } = await rows(f, { plugins: [{ path: kit, protocol: "codex" as const }] });
		expect(text.find((line) => line.includes("bare-kit (plugin"))).toContain(
			"no one provides: echo (did you mean plugin:bare-kit:echo?), elsewhere ·",
		);
	});

	it("list Claude and Codex skills through their harness rows, with no read-only skill-folder rows", async () => {
		const f = fixture();
		const store = path.join(f.home, "store");
		const skill = (dir: string, name: string) => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Skill ${name}.\n---\nBody.\n`);
		};
		skill(path.join(store, "observation-platform"), "observation-platform");
		skill(path.join(store, "claude-linked"), "claude-linked");
		fs.mkdirSync(path.join(f.home, ".codex/skills"), { recursive: true });
		fs.mkdirSync(path.join(f.home, ".claude/skills"), { recursive: true });
		fs.symlinkSync(path.join(store, "observation-platform"), path.join(f.home, ".codex/skills/observation-platform"));
		fs.symlinkSync(path.join(store, "claude-linked"), path.join(f.home, ".claude/skills/claude-linked"));
		skill(path.join(f.home, ".codex/skills/plain"), "plain");

		const { inventory } = await rows(f, {});
		expect(inventory.items.filter((item) => item.id.startsWith("skills-folder:"))).toEqual([]);
		const ids = inventory.items.map((item) => item.id);
		expect(ids).toEqual(expect.arrayContaining(["harness:claude", "harness:codex"]));
	});
});
