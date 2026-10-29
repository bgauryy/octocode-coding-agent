import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem } from "../../src/core/extensibility/inventory.ts";
import { switchItem } from "../../src/core/extensibility/switch.ts";
import { effectivePlugins, isSwitchedOn, pluginToggleId } from "../../src/core/extensibility/toggles.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { mergeScopedSettings } from "../../src/core/settings-manager/merge.ts";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { hookToggleIds } from "../../src/octocode/hooks/config/toggles.ts";
import { pluginsCommand } from "../../src/octocode/plugins/command.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { writeHookFiles } from "./fixtures/hook-formats.ts";
import { tmp } from "./helpers.ts";

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
		const all = loadedTags(f, {});
		expect(all).toHaveLength(9);
		const withoutClaude = loadedTags(f, { "hooks:claude": false });
		expect(withoutClaude).toEqual(all.filter((tag) => !tag.startsWith("claude-")));
		const { config } = loadHooks(f.cwd, true, f.home);
		const group = config.PreToolUse.find((candidate) =>
			candidate.hooks.some(
				(hook) => hook.source.endsWith(path.join(".claude", "settings.json")) && !hook.source.startsWith(f.cwd),
			),
		)!;
		const [hookId] = hookToggleIds("PreToolUse", group.matcher, group.hooks[0], f.home);
		expect(loadedTags(f, { "hooks:claude": false, [hookId]: true })).toEqual([...withoutClaude, "claude-user"].sort());
		const { errors } = loadHooks(f.cwd, true, f.home, { toggles: { "hooks:claude": false } });
		expect(errors.join("\n")).toMatch(/hooks? switched off in \/plugins/);
	});

	it("let a project switch only the repository's own hooks", () => {
		const f = fixture();
		const toggles = mergeScopedSettings({}, { toggles: { "hooks:claude": false, "hooks:codex": false } }).toggles!;
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

describe("/plugins", () => {
	it("lists every hook per host and switches one by ID", async () => {
		const f = fixture();
		const { api } = fakeHost();
		const command = pluginsCommand(api);
		const ctx = fakeCtx({ cwd: f.cwd, mode: "rpc" });
		await command.handler("", ctx);
		const listing = ctx.ui.notes.at(-1)!.message;
		for (const title of ["Claude Code", "Codex", "Octocode"]) expect(listing).toContain(title);
		expect(listing).toContain("[x] Hooks from Claude Code");
		await command.handler("disable hooks:claude", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("switched off globally. Run /reload to apply.");
		expect(JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toggles).toEqual({
			"hooks:claude": false,
		});
		await command.handler("disable nothing:here", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({ type: "warning" });
	});
});
