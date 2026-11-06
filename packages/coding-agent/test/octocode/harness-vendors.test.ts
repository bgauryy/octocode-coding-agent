import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import type { ConfigKind } from "../../src/core/discovery/types.ts";
import { claudeMemoryDir } from "../../src/core/discovery/vendors/claude.ts";
import { harnessStatuses } from "../../src/core/discovery/vendors/index.ts";
import { mergeToggles, type Toggles } from "../../src/core/extensibility/toggles.ts";
import { loadProjectContextFiles } from "../../src/core/resource-loader/context-files.ts";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { hooksReport } from "../../src/octocode/hooks/register/report.ts";
import { tmp } from "./helpers.ts";

function write(file: string, text: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

const skill = (dir: string, name: string, description = `${name} skill`) =>
	write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);

function workspace() {
	const home = tmp();
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const agentDir = tmp();
	const piDir = path.join(home, ".pi", "agent");
	const input = (toggles?: Toggles, projectTrusted = true) =>
		discoveryInput({ cwd, agentDir, home, projectTrusted, piRoots: [piDir], env: {}, toggles });
	const items = (kind: ConfigKind, toggles?: Toggles, trusted = true) =>
		configDiscovery.discover(kind, input(toggles, trusted));
	return { home, cwd, agentDir, piDir, input, items };
}

const CLAUDE_HOOKS = JSON.stringify({
	hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
});

describe("harness vendors", () => {
	it("turns on Octocode, .agents, root .mcp.json and Pi by default, and lists what the others hold without loading it", () => {
		const w = workspace();
		skill(path.join(w.home, ".claude", "skills"), "claude-one");
		skill(path.join(w.home, ".agents", "skills"), "agents-one");
		const statuses = new Map(harnessStatuses(w.input()).map((status) => [status.id, status]));
		expect(Object.fromEntries([...statuses].map(([id, status]) => [id, status.on]))).toEqual({
			octocode: true,
			agents: true,
			"mcp-json": true,
			pi: true,
			claude: false,
			codex: false,
			cursor: false,
		});
		expect(statuses.get("claude")).toMatchObject({ found: { skill: 1 }, loaded: {} });
		expect(statuses.get("agents")).toMatchObject({ found: { skill: 1 }, loaded: { skill: 1 } });
	});

	it("loads Claude Code skills and hooks once harness:claude is on", () => {
		const w = workspace();
		skill(path.join(w.home, ".claude", "skills"), "claude-one");
		write(path.join(w.home, ".claude", "settings.json"), CLAUDE_HOOKS);
		const claudeSkill = (toggles?: Toggles) => w.items("skill", toggles).find((item) => item.name === "claude-one");
		expect(claudeSkill()).toMatchObject({ loaded: false, provenance: { vendor: "claude", notLoaded: "switched-off" } });
		expect(claudeSkill({ "harness:claude": true })?.loaded).toBe(true);

		const off = loadHooks(w.cwd, true, w.home, { toggles: {} });
		expect(off.config.PreToolUse).toEqual([]);
		expect(off.switchedOff).toBe(1);
		const on = loadHooks(w.cwd, true, w.home, { toggles: { "harness:claude": true } });
		expect(on.config.PreToolUse.flatMap((group) => group.hooks)).toHaveLength(1);
		expect(on.switchedOff).toBe(0);
		const report = (switchedOff: number) =>
			hooksReport(true, off.config, off.errors, w.cwd, w.home, undefined, switchedOff);
		expect(report(off.switchedOff)).toContain("1 hook off: harness switched off, /harness to enable");
		expect(report(0)).not.toContain("harness switched off");
	});

	it("lists the SubagentStart/SubagentStop hooks-off note among the hook diagnostics, not at startup", () => {
		const w = workspace();
		write(
			path.join(w.home, ".claude", "settings.json"),
			JSON.stringify({ hooks: { SubagentStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
		);
		const loaded = loadHooks(w.cwd, true, w.home, { toggles: { "harness:claude": true } });
		expect(loaded.errors).toEqual([]);
		expect(hooksReport(true, loaded.config, loaded.errors, w.cwd, w.home)).toContain(
			"  SubagentStart hooks run only in subagents whose profile sets hooks: true; other subagents skip them",
		);
		expect(hooksReport(true, loadHooks(w.cwd, true, w.home, { toggles: {} }).config, [], w.cwd, w.home)).not.toContain(
			"run only in subagents",
		);
	});

	it("lets a project key reach only the project's own items", () => {
		const w = workspace();
		skill(path.join(w.home, ".claude", "skills"), "user-skill");
		skill(path.join(w.cwd, ".claude", "skills"), "project-skill");
		const toggles = mergeToggles(undefined, { "harness:claude": true });
		const loaded = Object.fromEntries(w.items("skill", toggles).map((item) => [item.name, item.loaded]));
		expect(loaded).toMatchObject({ "project-skill": true, "user-skill": false });
	});

	it("reads AGENTS.md and never CLAUDE.md", () => {
		const w = workspace();
		write(path.join(w.cwd, "CLAUDE.md"), "claude instructions");
		const files = () => loadProjectContextFiles({ cwd: w.cwd, agentDir: w.agentDir, contextRoot: w.cwd });
		expect(files()).toEqual([]);
		write(path.join(w.cwd, "AGENTS.md"), "agents instructions");
		expect(files().map((file) => file.content)).toEqual(["agents instructions"]);
	});

	it("keeps Pi models, settings and keybindings when Pi is switched off, and drops its skills", () => {
		const w = workspace();
		skill(path.join(w.piDir, "skills"), "pi-skill");
		for (const name of ["models.json", "settings.json", "keybindings.json"]) write(path.join(w.piDir, name), "{}");
		const toggles = { "harness:pi": false };
		expect(w.items("skill", toggles).find((item) => item.name === "pi-skill")?.provenance.notLoaded).toBe(
			"switched-off",
		);
		for (const kind of ["model", "setting", "keybinding"] as const)
			expect(w.items(kind, toggles).filter((item) => item.provenance.vendor === "pi" && item.loaded)).toHaveLength(1);
	});

	it("adds Claude Code's memory to the context only with harness:claude:memory, and never in an untrusted folder", () => {
		const w = workspace();
		const file = write(path.join(claudeMemoryDir(w.input()).dir, "MEMORY.md"), "remember this\n");
		expect(file).toContain(path.join(".claude", "projects"));
		expect(w.items("memory", { "harness:claude": true }).map((item) => item.loaded)).toEqual([false]);
		expect(w.items("memory", { "harness:claude:memory": true }).map((item) => item.loaded)).toEqual([true]);
		expect(w.items("memory", { "harness:claude:memory": true }, false)).toEqual([]);
		const context = (toggles: Toggles) =>
			loadProjectContextFiles({
				cwd: w.cwd,
				agentDir: w.agentDir,
				contextRoot: w.cwd,
				projectTrusted: true,
				toggles,
				home: w.home,
				env: {},
			});
		expect(context({})).toEqual([]);
		const [entry] = context({ "harness:claude:memory": true });
		expect(entry.path).toBe(file);
		expect(entry.content).toContain("Claude Code's auto memory");
		expect(entry.content).toContain("remember this");
	});

	it("settles a skill name across harnesses: Octocode, then .agents, then Pi, then Claude Code", () => {
		const w = workspace();
		skill(path.join(w.home, ".claude", "skills"), "dup", "claude");
		skill(path.join(w.piDir, "skills"), "dup", "pi");
		skill(path.join(w.home, ".agents", "skills"), "dup", "agents");
		skill(path.join(w.agentDir, "skills"), "dup", "octocode");
		const dup = w.items("skill", { "harness:claude": true }).filter((item) => item.name === "dup");
		expect(dup.map((item) => [item.provenance.vendor, item.loaded])).toEqual([
			["octocode", true],
			["agents", false],
			["pi", false],
			["claude", false],
		]);
		expect(dup.slice(1).every((item) => item.provenance.shadowedBy?.vendor === "octocode")).toBe(true);
	});
});
