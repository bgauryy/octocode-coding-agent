import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hookFiles, loadHooks } from "../../src/octocode/hooks/config.ts";
import { tmp } from "./helpers.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";

afterEach(() => vi.unstubAllEnvs());
function fixture() {
	const home = tmp();
	const cwd = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(cwd, ".git"));
	for (const root of [home, cwd]) fs.mkdirSync(path.join(root, ".codex"));
	vi.stubEnv("OCTOCODE_HOME", tmp());
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	return { home, cwd };
}
const definition = (command: string) =>
	`[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = '${command}'\ncommand_windows = 'windows-${command}'\n`;

it("loads user and trusted project inline TOML and merges JSON with a diagnostic", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.home, ".codex/config.toml"), definition("user"));
	fs.writeFileSync(path.join(f.cwd, ".codex/config.toml"), definition("project"));
	fs.writeFileSync(
		path.join(f.home, ".codex/hooks.json"),
		JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "json" }] }] } }),
	);
	const user = loadHooks(f.cwd, false, f.home);
	expect(commandsFor(user.config, "PreToolUse", ["Bash"])).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ command: "user", commandWindows: "windows-user", protocol: "codex" }),
		]),
	);
	expect(user.errors.join()).toContain("both hooks.json and inline TOML");
	expect(commandsFor(user.config, "PreToolUse", ["Bash"])).toHaveLength(2);
	expect(commandsFor(loadHooks(f.cwd, true, f.home).config, "PreToolUse", ["Bash"])).toHaveLength(3);
	expect(hookFiles(f.cwd, true, f.home)).toContain(path.join(f.cwd, ".codex/config.toml"));
});

it("honors Codex feature disablement without disabling native hooks and lets the trusted project override it", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.home, ".codex/config.toml"), `[features]\nhooks = false\n${definition("disabled")}`);
	fs.writeFileSync(
		path.join(process.env.OCTOCODE_HOME!, "hooks.json"),
		JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "native" }] }] } }),
	);
	const selected = () => commandsFor(loadHooks(f.cwd, true, f.home).config, "PreToolUse", ["Bash"]);
	expect(selected().map((hook) => "command" in hook && hook.command)).toEqual(["native"]);
	fs.writeFileSync(path.join(f.cwd, ".codex/config.toml"), "[features]\nhooks = true\n");
	expect(selected()).toHaveLength(2);
});

it("reports invalid TOML without exposing adjacent settings values", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.home, ".codex/config.toml"), 'secret = "never-print-this"\n[hooks\n');
	const result = loadHooks(f.cwd, false, f.home);
	expect(result.errors.join()).toContain("Invalid TOML");
	expect(result.errors.join()).not.toContain("never-print-this");
});

it("uses CODEX_HOME for user sources without changing project locations", () => {
	const f = fixture();
	const custom = tmp();
	vi.stubEnv("CODEX_HOME", custom);
	fs.writeFileSync(path.join(custom, "config.toml"), definition("custom-home"));
	fs.writeFileSync(path.join(f.home, ".codex/config.toml"), definition("default-home"));
	fs.writeFileSync(path.join(f.cwd, ".codex/config.toml"), definition("project"));
	const preview = loadHooks(f.cwd, true, f.home);
	expect(preview.errors).toEqual([]);
	expect(commandsFor(preview.config, "PreToolUse", ["Bash"]).map((hook) => "command" in hook && hook.command)).toEqual([
		"custom-home",
		"project",
	]);
	expect(hookFiles(f.cwd, true, f.home)).toContain(path.join(fs.realpathSync(custom), "config.toml"));
	expect(hookFiles(f.cwd, false, f.home)).not.toContain(path.join(f.home, ".codex/hooks.json"));
});

it("diagnoses an invalid CODEX_HOME without silently loading the default user hooks", () => {
	const f = fixture();
	vi.stubEnv("CODEX_HOME", path.join(f.home, "missing"));
	fs.writeFileSync(
		path.join(f.home, ".codex/hooks.json"),
		JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "unexpected" }] }] } }),
	);
	const result = loadHooks(f.cwd, false, f.home);
	expect(result.errors.join()).toContain("CODEX_HOME");
	expect(commandsFor(result.config, "PreToolUse", ["Bash"])).toEqual([]);
});
