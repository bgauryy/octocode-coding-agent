import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

it("loads one native command per canonical name through the real SDK", async () => {
	const cwd = tmp("native-command-");
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir);
	vi.stubEnv("HOME", cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(cwd, ".octocode"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OCTOCODE_OFFLINE", "1");
	vi.stubEnv("OCTOCODE_MCP", "0");
	vi.stubEnv("OCTOCODE_EXTRA_SKILLS", "0");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		const runner = session.extensionRunner;
		const commands = runner.getRegisteredCommands();
		const inventory = new Set([...BUILTIN_SLASH_COMMANDS, ...commands].map((command) => command.name));
		const guide = fs.readFileSync(path.join(import.meta.dirname, "../../docs/commands.md"), "utf8");
		expect(guide).toContain(`${inventory.size} slash commands`);
		for (const name of inventory) expect(guide).toMatch(new RegExp("^\\| `/" + name + "(?:[ `])", "m"));
		for (const name of [
			"agents",
			"api",
			"archive",
			"backlog",
			"jobs",
			"memory",
			"modelsettings",
			"optimize",
			"permissions",
			"plan",
			"resume",
			"rewind",
			"status",
			"trust",
			"web",
		])
			expect(commands.filter((command) => command.name === name)).toHaveLength(1);
		for (const name of ["permission", "sessions", "info", "session"]) {
			expect(commands.some((command) => command.name === name)).toBe(false);
			expect(runner.getCommand(name)).toBeUndefined();
		}
		for (const removed of [
			"continue",
			"usage",
			"cost",
			"stats",
			"allowed-tools",
			"list-agents",
			"peers",
			"octocode",
			"hooks",
		])
			expect(runner.getCommand(removed)).toBeUndefined();
		await session.controlPlan({ action: "enter" });
		for (const toolName of ["file", "bash", "agent", "execute", "browser", "debug", "mcp__unknown__read"]) {
			expect(await runner.emitToolCall({ type: "tool_call", toolCallId: toolName, toolName, input: {} })).toMatchObject(
				{ block: true },
			);
		}
		expect(
			await runner.emitUserBash({ type: "user_bash", command: "touch bypass", excludeFromContext: true, cwd }),
		).toMatchObject({ result: { cancelled: true } });
		// A read-only `!cmd` runs under plan mode, like an agent's read-only bash call.
		expect(
			await runner.emitUserBash({ type: "user_bash", command: "echo bypass", excludeFromContext: true, cwd }),
		).toBeUndefined();
		await session.controlPlan({ action: "leave" });

		expect(commands.filter((command) => command.name === "mcp")).toHaveLength(1);
		expect(commands.filter((command) => command.name === "llama")).toHaveLength(1);
	} finally {
		await session.dispose();
	}
});
