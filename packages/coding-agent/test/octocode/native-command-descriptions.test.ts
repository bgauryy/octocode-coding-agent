import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

// A command list shows descriptions in one line each, so usage lives in `argumentHint`, never in the description.
it("gives every native and bundled extension command a short description with its usage in argumentHint", async () => {
	const cwd = tmp("native-descriptions-");
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
		additionalExtensionPaths: ["builtin:mcp", "builtin:llama.cpp"],
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
		const commands = session.extensionRunner.getRegisteredCommands();
		expect(commands.map((command) => command.name)).toEqual(
			expect.arrayContaining(["archive", "backlog", "plan", "mcp"]),
		);
		for (const command of commands) {
			const description = command.description ?? "";
			expect(description.trim(), `/${command.name} description`).not.toBe("");
			expect(description.length, `/${command.name} description length`).toBeLessThanOrEqual(50);
			expect(description, `/${command.name} embeds usage`).not.toMatch(/ — | · |\[|<|\|/);
			expect(description.startsWith(`${command.name} `), `/${command.name} repeats its name`).toBe(false);
		}
		// Usage that used to sit in the description stays discoverable through the hint, which RPC and the `/` list expose.
		const hints = new Map(commands.map((command) => [command.name, command.argumentHint]));
		expect(hints.get("permissions")).toContain("grants");
		expect(hints.get("plan")).toContain("--approve <revision>");
		expect(hints.get("resume")).toBe("[all] [<query>|B<n>]");
		expect(hints.get("archive")).toBe("[<n>]");
		expect(hints.get("trust")).toBe("[off]");
		expect(hints.get("modelsettings")).toBe("[check]");
		expect(hints.get("backlog")).toContain("add <title>");
		expect(session.extensionRunner.getCommand("resume")?.argumentHint).toBe("[all] [<query>|B<n>]");
	} finally {
		await session.dispose();
	}
});
