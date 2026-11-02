import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hookFiles, loadHooks } from "../../src/octocode/hooks/config.ts";
import { registerHarnessCommand } from "../../src/octocode/harness/command.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { interpret, runHook } from "../../src/octocode/hooks/runner.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";

describe("documented hook discovery and controls", () => {
	it("runs the quick-start JSON example from the hook guide", async () => {
		const guide = fs.readFileSync(new URL("../../docs/hooks.md", import.meta.url), "utf8");
		const json = guide.match(/```json\n([\s\S]*?)\n```/)?.[1];
		expect(json).toBeDefined();
		const errors: string[] = [];
		const config = parseHooks(JSON.parse(json!), "docs/hooks.md", undefined, errors);
		expect(errors).toEqual([]);
		const commands = commandsFor(config, "SessionStart", ["startup"]);
		expect(commands).toHaveLength(1);
		const result = await runHook(commands[0], { hook_event_name: "SessionStart" }, tmp());
		expect(result.code).toBe(0);
		expect(interpret("SessionStart", result)).toEqual({ context: "Project hooks are active" });
	});
	it.each([null, [], "invalid", 42])("reports a malformed hooks container: %j", (hooks) => {
		const errors: string[] = [];
		const config = parseHooks({ hooks }, "settings.json", undefined, errors);
		expect(commandsFor(config, "PreToolUse", ["Bash"])).toEqual([]);
		expect(errors).toEqual(["settings.json: hooks must be an object; skipped"]);
	});

	it("allows ordinary settings files without a hooks property", () => {
		const errors: string[] = [];
		parseHooks({ theme: "dark" }, "settings.json", undefined, errors);
		expect(errors).toEqual([]);
	});

	it.each(["enable", "off"])("does not pretend /harness hooks %s changes execution", async (argument) => {
		const { api } = fakeHost();
		const hooks = registerHooks(api, { OCTOCODE_SUBAGENT: "1" }, tmp());
		const commands = new Subcommands();
		registerHarnessCommand(commands, hooks, api);
		const notify = vi.fn();
		await commands.get("harness")!.handler(`hooks ${argument}`, { hasUI: true, cwd: tmp(), ui: { notify } } as never);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /harness hooks"), "warning");
		expect(notify.mock.calls[0][0]).toContain("disableAllHooks");
		expect(hooks.summary()).toContain("off");
	});

	it("retains every source dialect and scope when identical commands are deduplicated", () => {
		const home = tmp();
		const runtimeHome = tmp();
		vi.stubEnv("OCTOCODE_HOME", runtimeHome);
		const root = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(root, ".git"));
		const files = hookFiles(root, true, home).filter((file) => !file.endsWith(".toml"));
		for (const file of files) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo same" }] }] } }),
			);
		}
		const expected = files.map((file, i) => ({
			path: file,
			dialect: ["claude", "codex", "octocode", "claude", "claude", "codex", "octocode"][i],
			scope: i < 3 ? "user" : "project",
		}));
		const ofDialect = (dialect: string) => expected.filter((origin) => origin.dialect === dialect);
		const config = loadHooks(root, true, home).config;
		expect(config.PreToolUse.flatMap((group) => group.hooks).map((hook) => hook.origins)).toEqual(
			expected.map((origin) => [origin]),
		);
		// Each profile runs its copy once; identical commands merge only within one profile.
		const selected = commandsFor(config, "PreToolUse", ["Bash"]);
		expect(selected.map((hook) => [hook.protocol ?? "octocode", hook.origins])).toEqual(
			(["claude", "codex", "octocode"] as const).map((dialect) => [dialect, ofDialect(dialect)]),
		);
		expect(commandsFor(config, "PreToolUse", ["Bash"])).toEqual(selected);
		expect(config.PreToolUse[0].hooks[0].origins).toEqual([expected[0]]);
	});

	it("discovers only the documented files at the repository root from a subdirectory", () => {
		const home = tmp();
		const runtimeHome = tmp();
		vi.stubEnv("OCTOCODE_HOME", runtimeHome);
		const root = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(root, ".git"));
		const cwd = path.join(root, "src", "nested");
		fs.mkdirSync(cwd, { recursive: true });
		const userToml = path.join(home, ".codex/config.toml");
		const userFiles = [
			path.join(home, ".claude/settings.json"),
			path.join(home, ".codex/hooks.json"),
			path.join(runtimeHome, "hooks.json"),
		];
		const projectFiles = [
			".claude/settings.json",
			".claude/settings.local.json",
			".codex/hooks.json",
			".octocode/hooks.json",
		].map((name) => path.join(root, name));
		const projectToml = path.join(root, ".codex/config.toml");
		expect(hookFiles(cwd, false, home)).toEqual([...userFiles.slice(0, 2), userToml, userFiles[2]]);
		expect(hookFiles(cwd, true, home).filter((file) => !file.endsWith(".toml"))).toEqual([
			...userFiles,
			...projectFiles,
		]);
		expect(hookFiles(cwd, true, home)).toContain(projectToml);
		for (const [index, file] of [...userFiles, ...projectFiles].entries()) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({
					hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `echo source-${index}` }] }] },
				}),
			);
		}
		const loaded = loadHooks(cwd, true, home);
		expect(loaded.errors).toEqual([]);
		expect(commandsFor(loaded.config, "PreToolUse", ["Bash"]).map((hook) => hook.source)).toEqual([
			...userFiles,
			...projectFiles,
		]);
		expect(commandsFor(loadHooks(cwd, false, home).config, "PreToolUse", ["Bash"])).toHaveLength(3);
	});
});
