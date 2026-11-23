import "../mcp-host.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildInventory } from "../../src/octocode/harness/inventory.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { writeHookFiles } from "./fixtures/hook-formats.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { activeEntries, buildContextView, problemSummary } from "../../src/core/discovery/context-view.ts";
import type { ConfigItem, ConfigKind, Provenance } from "../../src/core/discovery/types.ts";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { LoadedRow, loadedColumns } from "../../src/modes/interactive/interactive-mode/loaded-row.ts";
import { describeIgnoredKeys } from "../../src/core/settings-manager/ignored-keys.ts";
import type { Skill } from "../../src/core/skills.ts";
import { SkillListing } from "../../src/core/skills/listing.ts";
import { harnessRow, startupWarnings } from "../../src/modes/interactive/interactive-mode/discovery-rows.ts";
import { formatHarnessesForPrompt } from "../../src/core/discovery/vendors/prompt.ts";
import type { HarnessStatus } from "../../src/core/discovery/vendors/types.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { vendorItems } from "../../src/octocode/harness/vendor-items.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

beforeAll(() => initTheme("dark", false));

const status = (
	id: HarnessStatus["id"],
	label: string,
	on: boolean,
	found: HarnessStatus["found"] = {},
): HarnessStatus => ({ id, label, on, defaultOn: on, switchable: id !== "octocode", found, loaded: on ? found : {} });
const STATUSES: HarnessStatus[] = [
	status("octocode", "Octocode", true),
	status("agents", ".agents", true, { skill: 1 }),
	status("claude", "Claude Code", false, { skill: 1, hook: 1, mcp: 2 }),
	status("cursor", "Cursor", false, { mcp: 1 }),
];

const home = homedir();

function item(
	kind: ConfigKind,
	name: string,
	provenance: Partial<Provenance> & { path: string },
	loaded = true,
): ConfigItem {
	return {
		kind,
		name,
		loaded,
		diagnostics: [],
		provenance: { product: "octocode", vendor: "octocode", scope: "global", origin: "octocode", ...provenance },
	};
}

const agentsSkill = (name: string) =>
	item("skill", name, { vendor: "agents", origin: "agents", path: join(home, ".agents/skills", name, "SKILL.md") });
const piCopy = (name: string) =>
	item(
		"skill",
		name,
		{
			product: "pi",
			vendor: "pi",
			origin: "pi",
			path: join(home, ".pi/agent/skills", name, "SKILL.md"),
			shadowedBy: agentsSkill(name).provenance,
		},
		false,
	);

describe("startup banner from the context view", () => {
	it("counts only loaded skills and says in one line how many duplicates were skipped and where the winner loads", () => {
		const claude = item(
			"skill",
			"claude-only",
			{
				vendor: "claude",
				origin: "claude",
				path: join(home, ".claude/skills/claude-only/SKILL.md"),
				notLoaded: "switched-off",
			},
			false,
		);
		const view = buildContextView({
			discovery: new Map([["skill", [agentsSkill("a"), agentsSkill("b"), piCopy("a"), piCopy("b"), claude]]]),
		});
		const skills = view.groups.find((group) => group.id === "skill");
		if (!skills) throw new Error("no skill group");

		expect(activeEntries(skills)).toHaveLength(2);
		expect(problemSummary(skills)).toBe("2 duplicate · 1 off");
		expect(skills.entries.find((entry) => entry.name === "claude-only")?.note).toBe("harness off (/harness)");
		// A switched-off harness is the user's choice: no warning, and not in the Not loaded group.
		expect(view.groups.some((group) => group.id === "extension")).toBe(false);
		expect(view.warnings.map((warning) => warning.text)).toEqual([
			"2 duplicate skills skipped, kept ~/.agents/skills (ctrl+o lists)",
		]);
	});

	it("names a cached plugin by its plugin folder, not its version folder", () => {
		const plugin = item("plugin", "1.0.0", {
			origin: "plugin",
			path: join(home, ".claude/plugins/cache/official/rust-analyzer-lsp/1.0.0"),
		});
		const view = buildContextView({ discovery: new Map([["plugin", [plugin]]]) });

		expect(view.groups[0]?.entries[0]?.name).toBe("rust-analyzer-lsp");
	});

	it("lists a loaded skill under its own folder when a switched-off harness's folder links to the same files", () => {
		const root = mkdtempSync(join(tmpdir(), "harness-symlinks-"));
		try {
			const real = join(root, "code", "skills", "research");
			mkdirSync(real, { recursive: true });
			writeFileSync(join(real, "SKILL.md"), "---\nname: research\ndescription: d\n---\n");
			const linked = (dir: string) => {
				mkdirSync(join(root, dir, "skills"), { recursive: true });
				symlinkSync(real, join(root, dir, "skills", "research"));
				return join(root, dir, "skills", "research", "SKILL.md");
			};
			const agents = item("skill", "research", { vendor: "agents", origin: "agents", path: linked(".agents") });
			const cursorPath = linked(".cursor");
			const cursor = item(
				"skill",
				"research",
				{ vendor: "cursor", origin: "cursor", path: cursorPath, notLoaded: "switched-off" },
				false,
			);
			// The loader may report the file by either link or by its real path: each names the .agents copy.
			for (const loadedPath of [agents.provenance.path, join(real, "SKILL.md")]) {
				const view = buildContextView({
					discovery: new Map([["skill", [agents, cursor]]]),
					loaded: { skill: [{ path: loadedPath, name: "research" }] },
				});
				const skills = view.groups.find((group) => group.id === "skill");
				expect(skills?.entries.map((entry) => [entry.source, entry.state, entry.note ?? ""])).toEqual([
					["agents global", "loaded", ""],
					["cursor global", "off", "harness off (/harness)"],
				]);
				expect(skills && activeEntries(skills).map((entry) => entry.path)).toEqual([agents.provenance.path]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("counts a Claude Code or Codex plugin named in settings as loaded and labels where it came from", () => {
		const root = mkdtempSync(join(tmpdir(), "harness-plugins-"));
		try {
			const plugin = (dir: string, name: string, manifest: string) => {
				const path = join(root, dir, name, "1.0.0");
				mkdirSync(join(path, manifest), { recursive: true });
				writeFileSync(join(path, manifest, "plugin.json"), JSON.stringify({ name }));
				return path;
			};
			const claude = plugin(".claude/plugins/cache/official", "rust-analyzer-lsp", ".claude-plugin");
			const codex = plugin(".codex/plugins/cache/bundled", "browser", ".codex-plugin");
			const items = configDiscovery.discover(
				"plugin",
				discoveryInput({
					cwd: join(root, "work"),
					agentDir: join(root, ".octocode"),
					projectTrusted: true,
					home: root,
					env: {},
					plugins: [
						{ path: claude, protocol: "claude" },
						{ path: codex, protocol: "codex" },
					],
				}),
			);
			const group = buildContextView({ discovery: new Map([["plugin", items]]) }).groups[0];

			expect(group?.entries.map((entry) => [entry.name, entry.source, entry.state, entry.note])).toEqual([
				["rust-analyzer-lsp", "claude plugin", "loaded", "Claude Code plugin, added in settings"],
				["browser", "codex plugin", "loaded", "Codex plugin, added in settings"],
			]);
			// Octocode's own setting loads them, so they never count toward a switched-off harness.
			expect(items.map((found) => found.provenance.vendor)).toEqual(["octocode", "octocode"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("groups MCP servers by the harness whose file defines them", () => {
		const server = (name: string, source: string, scope = "project") => ({
			name,
			enabled: true,
			state: "connected",
			source,
			scope,
		});
		const view = buildContextView({
			discovery: new Map(),
			mcp: [
				server("a", "/repo/.agents/mcp.json"),
				server("r", "/repo/.mcp.json"),
				server("c", join(home, ".claude.json"), "global"),
				server("o", join(home, ".octocode/mcp.json"), "global"),
			],
		});

		expect(view.groups[0]?.entries.map((entry) => entry.source)).toEqual([
			".agents",
			"root .mcp.json",
			"claude global",
			"octocode global",
		]);
	});

	it("keeps Codex metadata notes out of the warnings and reports keybinding and invalid skill problems in one line each", () => {
		const view = buildContextView({ discovery: new Map() });
		const { warnings, notes } = startupWarnings(
			view,
			[
				{ type: "warning", message: "metadata validated but not activated", path: "/s/x/agents/openai.yaml" },
				{ type: "warning", message: "name is required", path: "/s/bad/SKILL.md" },
				{
					type: "collision",
					message: "duplicate",
					collision: {
						resourceType: "skill",
						name: "dup",
						winnerPath: "/w/skills/dup/SKILL.md",
						loserPath: "/l/dup/SKILL.md",
					},
				},
			],
			[{ path: "/k/keybindings.json", problem: "1 entry ignored (unknown action foo): fix or delete them" }],
		);

		expect(warnings.map((warning) => warning.text)).toEqual([
			"1 duplicate skill skipped, kept /w/skills (ctrl+o lists)",
			"1 skill file with problems: invalid SKILL.md or folder (ctrl+o lists)",
			"/k/keybindings.json: 1 entry ignored (unknown action foo): fix or delete them",
		]);
		expect(notes).toHaveLength(1);
		expect(notes[0]?.details).toEqual(["/s/x/agents/openai.yaml: metadata validated but not activated"]);
	});

	it("condenses a settings file's ignored keys into one line", () => {
		expect(describeIgnoredKeys(["thinkingBudgets.xhigh", "compaction"])).toBe(
			"2 ignored keys (thinkingBudgets.xhigh, compaction): /settings unset thinkingBudgets.xhigh compaction",
		);
		expect(describeIgnoredKeys(["typo"], "project")).toBe("1 ignored key (typo): /settings unset typo --local");
		expect(describeIgnoredKeys([])).toBeUndefined();
	});
});

describe("harnesses", () => {
	it("forwards the formatted harness inventory to the system prompt only when provided", () => {
		expect(buildSystemPrompt({ cwd: "/repo", harnesses: STATUSES })).toContain(formatHarnessesForPrompt(STATUSES));
		expect(buildSystemPrompt({ cwd: "/repo" })).not.toContain("Harnesses:");
	});

	it("groups switchable harnesses by on and off, then /harness", () => {
		const row = harnessRow(STATUSES);

		expect(row.count()).toBe(1);
		expect(stripAnsi(row.summary())).toBe("on: .agents · off: Claude Code, Cursor · /harness");
	});

	const LIVE: HarnessStatus[] = [
		status("octocode", "Octocode", true),
		status("agents", ".agents", true, { skill: 13 }),
		status("mcp-json", "root .mcp.json", true, { mcp: 1 }),
		status("pi", "Pi", true, { skill: 14 }),
		status("claude", "Claude Code", false, { skill: 15, hook: 2, mcp: 1 }),
		status("codex", "Codex", false, { skill: 1, hook: 3, mcp: 7 }),
		status("cursor", "Cursor", false, { skill: 13 }),
	];
	const drawn = (width: number) => {
		const row = harnessRow(LIVE);
		return new LoadedRow(row, () => loadedColumns([row]), false).render(width).map(stripAnsi);
	};

	it("fits grouped on/off names in 200 columns with /harness at the end", () => {
		const lines = drawn(200);

		expect(lines).toEqual([
			"Harness  ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness",
		]);
	});

	it("wraps grouped on/off names in 80 columns and always ends with /harness", () => {
		const lines = drawn(80);

		for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
		const text = lines.join(" ").replace(/\s+/g, " ");
		expect(text).toBe("Harness ✓ 3 on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness");
		expect(lines.at(-1)?.endsWith("/harness")).toBe(true);
		expect(text).not.toContain("\u2026");
		// Wrapped lines start under the first harness, and no harness is split across lines.
		for (const line of lines.slice(1)) expect(line.startsWith("              ")).toBe(true);
	});

	it("wraps a group wider than the room between its names at 40 columns, cutting none", () => {
		const lines = drawn(40);
		for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(40);
		const text = lines.join(" ").replace(/\s+/g, " ");
		expect(text).toBe("Harness ✓ 3 on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness");
		expect(lines.at(-1)?.endsWith("/harness")).toBe(true);
		// A wrap falls after a comma, never inside a name.
		for (const name of ["root .mcp.json", "Claude Code"])
			expect(
				lines.some((line) => line.includes(name)),
				name,
			).toBe(true);
	});

	it("shows a switched-off harness's hooks off in /harness, whatever their own switch, and on once the harness is on", async () => {
		const root = mkdtempSync(join(tmpdir(), "harness-hooks-"));
		try {
			const home = join(root, "home");
			const cwd = join(root, "repo");
			writeHookFiles(home, cwd, join(root, "log"));
			const claudeHooks = async (toggles: Record<string, boolean>) => {
				const settings = { toggles };
				const inventory = await buildInventory({
					cwd,
					agentDir: join(home, ".octocode", "octocodecode"),
					settings,
					manager: SettingsManager.inMemory(settings),
					projectTrusted: true,
					home,
				});
				return inventory.items.filter((item) => item.host === "claude" && item.kind.startsWith("hook"));
			};
			// Claude Code is off by default: its hooks do not load, so no row says they are on.
			const off = await claudeHooks({});
			expect(off.length).toBeGreaterThan(2);
			expect(off.every((item) => !item.on && item.detail.startsWith("off: Claude Code harness switched off"))).toBe(
				true,
			);
			const on = await claudeHooks({ "harness:claude": true });
			expect(on.find((item) => item.kind === "hooks")).toMatchObject({ label: "Hooks from Claude Code", on: true });
			expect(on.some((item) => item.detail.includes("harness switched off"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lists one /harness row per harness, its ID the toggles key, and the Claude memory switch under Claude Code", () => {
		const rows = vendorItems(STATUSES, { "harness:claude:memory": true });

		expect(rows.map((row) => [row.id, row.on, row.locked ?? ""])).toEqual([
			["harness:octocode", true, "always on"],
			["harness:agents", true, ""],
			["harness:claude", false, ""],
			["harness:claude:memory", true, ""],
			["harness:cursor", false, ""],
		]);
		expect(rows[2]?.detail).toBe("default off · found 1 skill, 1 hook, 2 MCP servers");
	});
});

describe("skills in the skill tool's description", () => {
	it("lists a fixture skill by the path the tool loads it from", () => {
		const skill = {
			name: "demo",
			description: "Demo skill.",
			filePath: "/skills/demo/SKILL.md",
			baseDir: "/skills/demo",
		} as Skill;
		expect(SkillListing.fromSkills([skill]).render()).toContain("/skills/demo/SKILL.md: Demo skill.");
	});
});
