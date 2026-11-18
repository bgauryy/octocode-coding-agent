import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getNativeSkillsDir, getOctocodeHome, getOctocodeSkillsDir } from "../../src/config.ts";
import { buildInventory } from "../../src/octocode/harness/inventory.ts";
import { switchItem } from "../../src/core/extensibility/switch.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { getBuiltinCommand } from "../../src/core/slash-commands.ts";
import { installOctocodeDiscovery } from "../../src/octocode/discovery/index.ts";
import { installMcpCorePorts } from "../../src/octocode/mcp-host/core.ts";
import { tmp } from "./helpers.ts";

beforeAll(() => {
	installMcpCorePorts();
	installOctocodeDiscovery();
});
afterEach(() => vi.unstubAllEnvs());

function writeSkill(dir: string, name: string): string {
	const file = path.join(dir, name, "SKILL.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\nBody.\n`);
	return file;
}

/** A home with Pi compatibility on: the default Octocode home, no explicit home or agent directory. */
function fixture() {
	const home = fs.realpathSync(tmp());
	const cwd = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(cwd, ".git"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	vi.stubEnv("CODEX_HOME", "");
	const agentDir = getOctocodeHome();
	fs.mkdirSync(agentDir, { recursive: true });
	return { home, cwd, agentDir };
}

async function skillRows(f: ReturnType<typeof fixture>) {
	const manager = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
	const inventory = await buildInventory({
		cwd: f.cwd,
		agentDir: f.agentDir,
		settings: manager.getSettings(),
		manager,
		projectTrusted: true,
		home: f.home,
	});
	return { manager, rows: inventory.items.filter((item) => item.kind === "skill") };
}

describe("skills in /harness", () => {
	it("replace the retired /skills command", () => {
		expect(getBuiltinCommand("skills")).toBeUndefined();
	});

	it("switch a project skill off and on through the project settings", async () => {
		const f = fixture();
		const file = writeSkill(path.join(f.cwd, ".agents", "skills"), "review");
		const first = await skillRows(f);
		const row = first.rows.find((item) => item.id.endsWith(`${path.sep}${path.join("review", "SKILL.md")}`));
		expect(row).toMatchObject({ on: true, project: true });
		switchItem(row!, false, "project", first.manager, f);
		await first.manager.flush();
		const off = await skillRows(f);
		expect(off.rows.find((item) => item.id === row!.id)?.on).toBe(false);
		switchItem(
			off.rows.find((item) => item.id === row!.id)!,
			true,
			"project",
			off.manager,
			f,
		);
		await off.manager.flush();
		expect((await skillRows(f)).rows.find((item) => item.id === row!.id)?.on).toBe(true);
		expect(fs.existsSync(file)).toBe(true);
	});

	it("list each core skill by name, and switching one off globally drops it from the session", async () => {
		const f = fixture();
		const { manager, rows } = await skillRows(f);
		const core = rows.filter((item) => item.detail.startsWith("Octocode (core)"));
		expect(core.map((item) => item.id)).toEqual(
			expect.arrayContaining(["skill:octocode-debugging", "skill:resume-external-harness"]),
		);
		const row = core.find((item) => item.name === "resume-external-harness")!;
		expect(row.on).toBe(true);
		expect(() => switchItem(row, false, "project", manager, f)).toThrow(/switch it globally/);
		switchItem(row, false, "global", manager, f);
		await manager.flush();
		// The pattern is relative to the core skills folder, so it survives a reinstall elsewhere.
		expect(manager.getGlobalSettings().skills).toEqual(["-resume-external-harness/SKILL.md"]);
		expect((await skillRows(f)).rows.find((item) => item.id === row.id)?.on).toBe(false);
		// The session reads the core folder through `resources_discover`; the same pattern drops the skill there.
		const loader = new DefaultResourceLoader({
			settingsManager: SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true }),
			cwd: f.cwd,
			agentDir: f.agentDir,
		});
		await loader.reload();
		loader.extendResources({
			skillPaths: [
				{
					path: getNativeSkillsDir(),
					metadata: { source: "extension:octocode", scope: "temporary", origin: "top-level" },
				},
			],
		});
		const names = loader.getSkills().skills.map((skill) => skill.name);
		expect(names).toContain("octocode-debugging");
		expect(names).not.toContain("resume-external-harness");
	});

	it.skipIf(!getOctocodeSkillsDir())(
		"list each Octocode collection skill, and switching one off globally drops it from the resolved skills",
		async () => {
			const f = fixture();
			const { manager, rows } = await skillRows(f);
			const row = rows.find((item) => item.name === "octocode-roast");
			expect(row).toMatchObject({ on: true, detail: "Octocode (collection) · skills/octocode-roast/SKILL.md" });
			switchItem(row!, false, "global", manager, f);
			await manager.flush();
			// Relative to the collection folder, like a core skill's switch: a reinstall elsewhere keeps it.
			expect(manager.getGlobalSettings().skills).toEqual(["-octocode-roast/SKILL.md"]);
			const after = await skillRows(f);
			expect(after.rows.find((item) => item.id === row!.id)?.on).toBe(false);
			const resolved = await new DefaultPackageManager({
				cwd: f.cwd,
				agentDir: f.agentDir,
				settingsManager: after.manager,
				builtinSkillsDir: getOctocodeSkillsDir(),
			}).resolve(async () => "skip");
			const state = (name: string) =>
				resolved.skills.find((skill) => skill.path.endsWith(`${path.sep}${name}${path.sep}SKILL.md`))?.enabled;
			expect(state("octocode-roast")).toBe(false);
			expect(state("octocode-research")).toBe(true);
		},
	);

	it.skipIf(!getOctocodeSkillsDir())("switch an Octocode collection skill off in a trusted project only", async () => {
		const f = fixture();
		const { manager, rows } = await skillRows(f);
		const row = rows.find((item) => item.name === "octocode-roast")!;
		switchItem(row, false, "project", manager, f);
		await manager.flush();
		expect(manager.getGlobalSettings().skills ?? []).toEqual([]);
		expect((await skillRows(f)).rows.find((item) => item.id === row.id)?.on).toBe(false);
	});

	it("add no skill from Claude Code, Codex or Cursor until their harness is switched on", async () => {
		const f = fixture();
		writeSkill(path.join(f.home, ".claude", "skills"), "claude-review");
		writeSkill(path.join(f.home, ".codex", "skills"), "codex-review");
		writeSkill(path.join(f.home, ".cursor", "skills"), "cursor-review");
		writeSkill(path.join(f.cwd, ".claude", "skills"), "claude-project");
		const external = /(claude|codex|cursor)-(review|project)/;
		const { manager, rows } = await skillRows(f);
		expect(rows.filter((item) => external.test(item.id))).toEqual([]);
		// The session's resources come from the same resolver: nothing external reaches the agent either.
		const resolved = await new DefaultPackageManager({
			cwd: f.cwd,
			agentDir: f.agentDir,
			settingsManager: manager,
		}).resolve(async () => "skip");
		expect(resolved.skills.filter((skill) => external.test(skill.path))).toEqual([]);
		manager.setToggle("global", "harness:claude", true);
		await manager.flush();
		const on = (await skillRows(f)).rows.filter((item) => external.test(item.id)).map((item) => item.label);
		expect(on.sort()).toEqual(["claude-project", "claude-review"]);
	});

	it("show a Pi skill that Pi's own settings disable as off", async () => {
		const f = fixture();
		const file = writeSkill(path.join(f.home, ".pi", "agent", "skills"), "run-test");
		fs.writeFileSync(path.join(f.home, ".pi", "agent", "settings.json"), JSON.stringify({ skills: [`-${file}`] }));
		const { rows } = await skillRows(f);
		expect(rows.find((item) => item.label === "run-test")?.on).toBe(false);
	});

	it("list Pi's global skills read-only, and drop them when the Pi harness is off", async () => {
		const f = fixture();
		writeSkill(path.join(f.home, ".pi", "agent", "skills"), "run-test");
		const { manager, rows } = await skillRows(f);
		const pi = rows.find((item) => item.label === "run-test");
		expect(pi).toMatchObject({ on: true, detail: expect.stringContaining("Pi (global)") });
		expect(pi?.locked).toContain("harness:pi");
		expect(() => switchItem(pi!, false, "global", manager, f)).toThrow(/Pi's own settings/);
		manager.setToggle("global", "harness:pi", false);
		await manager.flush();
		expect((await skillRows(f)).rows.some((item) => item.label === "run-test")).toBe(false);
	});

	it.skipIf(!fs.existsSync(path.join(getOctocodeSkillsDir() ?? "", "octocode-debugging", "SKILL.md")))(
		"say the core skill wins over the Octocode collection's copy of the same name",
		async () => {
			const f = fixture();
			const { rows } = await skillRows(f);
			const copies = rows.filter((item) => item.label === "octocode-debugging");
			expect(copies).toHaveLength(2);
			const collectionCopy = copies.find((item) => item.detail.includes("Octocode (collection)"));
			expect(collectionCopy).toMatchObject({
				on: true,
				detail: expect.stringMatching(/^not loaded: Octocode \(core\) wins · Octocode \(collection\)/),
			});
			expect(copies.find((item) => item !== collectionCopy)?.detail).toMatch(/^Octocode \(core\)/);
		},
	);

	it("say which copy wins when a switched-on skill shares its name with another", async () => {
		const f = fixture();
		// A core skill the Octocode collection has no copy of, so the Pi copy is the only other one.
		writeSkill(path.join(f.home, ".pi", "agent", "skills"), "resume-external-harness");
		const { rows } = await skillRows(f);
		const copies = rows.filter((item) => item.label === "resume-external-harness");
		expect(copies).toHaveLength(2);
		const loser = copies.find((item) => item.detail.includes("Pi (global)"));
		expect(loser).toMatchObject({
			on: true,
			detail: expect.stringMatching(/^not loaded: Octocode \(core\) wins · Pi \(global\)/),
		});
		expect(copies.find((item) => item !== loser)?.detail).not.toContain("not loaded");
	});
});
