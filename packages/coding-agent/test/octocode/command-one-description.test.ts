import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { createTestSession } from "../helpers/session.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

it("every command name shown in the registry has one description of at most 50 characters", async () => {
	const cwd = tmp("one-description-");
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
		const descriptions = new Map<string, Set<string>>();
		const add = (name: string, description: string | undefined) =>
			descriptions.set(name, (descriptions.get(name) ?? new Set()).add(description ?? ""));
		for (const command of BUILTIN_SLASH_COMMANDS) add(command.name, command.description);
		for (const command of session.extensionRunner.getRegisteredCommands())
			if (command.sourceInfo.owner === "native") add(command.name, command.description);
		for (const [name, texts] of descriptions) {
			expect([name, [...texts]]).toEqual([name, [[...texts][0]]]);
			const [text] = [...texts];
			expect(text.trim(), name).not.toBe("");
			expect(text.length, name).toBeLessThanOrEqual(50);
		}
		for (const name of ["permissions", "agents", "plan", "status", "resume", "modelsettings"])
			expect(descriptions.has(name), name).toBe(true);
	} finally {
		session.dispose();
	}
});
