import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadSkills } from "../../src/core/skills.ts";
import { commandsFor, hookFiles, loadHooks } from "../../src/octocode/hooks/config.ts";
import { extraSkillDirs } from "../../src/octocode/skills.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());
const definition = (command: string) =>
	JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } });
it("uses the selected Claude user home for preview hooks and leaves project and legacy sources intact", () => {
	const home = tmp();
	const custom = tmp();
	const cwd = fs.realpathSync(tmp());
	vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".claude"));
	fs.writeFileSync(path.join(home, ".claude/settings.json"), definition("default"));
	fs.writeFileSync(path.join(custom, "settings.json"), definition("custom"));
	fs.writeFileSync(path.join(cwd, ".claude/settings.json"), definition("project"));
	const selected = (trusted: boolean, sourceProfiles: boolean) =>
		commandsFor(loadHooks(cwd, trusted, home, { sourceProfiles }).config, "PreToolUse", ["Bash"]).map(
			(h) => "command" in h && h.command,
		);
	expect(selected(false, true)).toEqual(["custom"]);
	expect(selected(true, true)).toEqual(["custom", "project"]);
	expect(selected(false, false)).toEqual(["default"]);
	expect(hookFiles(cwd, false, home, true)).toContain(path.join(custom, "settings.json"));
});
it("retains Claude parsing and synced-skill exclusion under a custom home", () => {
	const home = tmp();
	const custom = tmp();
	const codex = tmp();
	const cwd = tmp();
	vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
	vi.stubEnv("CODEX_HOME", codex);
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(custom, "skills/local"), { recursive: true });
	fs.mkdirSync(path.join(custom, "skills/synced/remote"), { recursive: true });
	fs.mkdirSync(path.join(codex, "skills"));
	for (const dir of ["local", "synced/remote"])
		fs.writeFileSync(
			path.join(custom, "skills", dir, "SKILL.md"),
			`---\nname: ${dir === "local" ? "local" : "remote"}\nuser-invocable: "no"\n---\nBody description.`,
		);
	const paths = extraSkillDirs(cwd, home, false);
	expect(paths).toContain(path.join(fs.realpathSync(codex), "skills"));
	const loaded = loadSkills({ cwd, agentDir: tmp(), includeDefaults: false, skillPaths: paths });
	expect(loaded.skills).toHaveLength(1);
	expect(loaded.skills[0]).toMatchObject({
		name: "local",
		description: "Body description.",
		argumentStyle: "claude",
		userInvocable: false,
	});
});
it("does not fall back to other user skill profiles when selected homes are missing", () => {
	const home = tmp();
	for (const name of [".claude", ".codex"]) fs.mkdirSync(path.join(home, name, "skills"), { recursive: true });
	expect(
		extraSkillDirs(tmp(), home, false, {
			CLAUDE_CONFIG_DIR: path.join(home, "absent-claude"),
			CODEX_HOME: path.join(home, "absent-codex"),
		}),
	).toEqual([]);
});
