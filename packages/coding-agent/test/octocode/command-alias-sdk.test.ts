import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

it("loads one canonical native command per row and resolves aliases through the real SDK", async () => {
	const cwd = tmp("native-command-alias-");
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir);
	vi.stubEnv("HOME", cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(cwd, ".octocode"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OCTOCODE_OFFLINE", "1");
	vi.stubEnv("OCTOCODE_MCP", "0");
	vi.stubEnv("OCTOCODE_API", "0");
	vi.stubEnv("OCTOCODE_EXTRA_SKILLS", "0");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: ["builtin:mcp"],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		const runner = session.extensionRunner;
		const commands = runner.getRegisteredCommands();
		for (const [name, alias] of [
			["permissions", "permission"],
			["resume", "sessions"],
			["status", "info"],
		]) {
			const canonical = commands.filter((command) => command.name === name);
			expect(canonical).toHaveLength(1);
			expect(canonical[0]!.aliases).toContain(alias);
			expect(commands.some((command) => command.name === alias)).toBe(false);
			expect(runner.getCommand(alias!)?.handler).toBe(runner.getCommand(name!)?.handler);
		}
		expect(commands.filter((command) => command.name === "mcp")).toHaveLength(1);
		expect(commands.some((command) => command.name === "octocode")).toBe(false);
	} finally {
		await session.dispose();
	}
});
