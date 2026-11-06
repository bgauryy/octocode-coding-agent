import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getOctocodeHome } from "../../src/config.ts";
import { buildInventory } from "../../src/core/extensibility/inventory.ts";
import { switchItem } from "../../src/core/extensibility/switch.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
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
		const row = first.rows.find((item) => item.id.endsWith(path.join("review", "SKILL.md")));
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
		expect(pi?.locked).toContain("/harness disable pi");
		expect(() => switchItem(pi!, false, "global", manager, f)).toThrow(/Pi's own settings/);
		manager.setToggle("global", "harness:pi", false);
		await manager.flush();
		expect((await skillRows(f)).rows.some((item) => item.label === "run-test")).toBe(false);
	});
});
