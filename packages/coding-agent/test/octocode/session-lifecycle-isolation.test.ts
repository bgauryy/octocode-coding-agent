import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { WindowsHelper, windowsTree } from "../../src/utils/windows/winhelper.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

it("keeps another native SDK session's team usable after shutdown and reload", async () => {
	const cwd = tmp("session-lifecycle-isolation-");
	vi.stubEnv("OCTOCODE_HOME", path.join(cwd, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(cwd, "agent.sqlite"));
	vi.stubEnv("OCTOCODE_EXTRA_SKILLS", "0");
	vi.stubEnv("OCTOCODE_CLEANUP_DAYS", "0");
	const start = async () => {
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: path.join(cwd, "agent"),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(cwd, "agent"),
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined });
		return session;
	};
	const first = await start();
	const second = await start();
	const helper = new WindowsHelper({
		platform: () => "win32",
		shells: ["fixture"],
		spawn: (_command, _args, options) =>
			spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/fake-win-helper.mjs")], options),
	});
	const stopHelper = vi.spyOn(windowsTree, "stopAll").mockImplementation(() => helper.stopAll());
	const coordinate = async (session: typeof first, action: string) => {
		const tool = session.agent.state.tools.find((tool) => tool.name === "agent")!;
		return tool.execute("lifecycle-call", { type: "coordinate", input: { action } });
	};
	try {
		await coordinate(first, "join");
		await coordinate(second, "join");
		expect(await helper.assign(4242)).toBe(true);
		await first.reload();
		expect(helper.owns(4242)).toBe(true);
		await expect(coordinate(second, "join")).resolves.toBeDefined();
		await coordinate(first, "join");
		await first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		first.dispose();
		expect(helper.owns(4242)).toBe(true);
		await expect(coordinate(second, "join")).resolves.toBeDefined();
		expect((await coordinate(second, "list")).content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("(you)") })]),
		);
		await second.reload();
		await expect(coordinate(second, "join")).resolves.toBeDefined();
	} finally {
		await second.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		second.dispose();
		stopHelper.mockRestore();
		await helper.stopAll();
	}
});
