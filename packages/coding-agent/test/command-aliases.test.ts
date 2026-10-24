import { expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";
import { getPromptCommands } from "../src/core/prompt-templates.ts";
import { getSkillCommands } from "../src/core/skill-commands.ts";
import { NATIVE_FEATURE_PATH } from "../src/core/native-tools.ts";

it("keeps native aliases and colliding extensions, skills and prompts reachable after resolution", async () => {
	const native = vi.fn(async () => {});
	const extension = vi.fn(async () => {});
	const harness = await createHarness({
		extensionFactories: [
			{
				path: NATIVE_FEATURE_PATH,
				factory: (pi) => {
					pi.registerCommand("agents", { aliases: ["peers", "list-agents"], handler: native });
				},
			},
			(pi) => {
				pi.registerCommand("agents", { aliases: ["peers"], handler: extension });
				pi.registerCommand("clear", { handler: extension });
				pi.registerCommand("custom", { aliases: ["config"], handler: extension });
			},
		],
	});
	try {
		const runner = harness.session.extensionRunner;
		expect(runner.getCommand("agents")?.handler).toBe(native);
		expect(runner.getCommand("peers")?.handler).toBe(native);
		const commands = runner.getRegisteredCommands();
		const qualified = commands.find((command) => command.name === "agents" && command.handler === extension)!;
		expect(qualified.invocationName).toMatch(/^agents:\d+$/);
		expect(qualified.invocationAliases?.[0]).toMatch(/^peers:\d+$/);
		await harness.session.prompt("/peers\tstatus");
		expect(native).toHaveBeenCalledWith("status", expect.anything());
		await harness.session.prompt(`/${qualified.invocationAliases![0]} status`);
		expect(extension).toHaveBeenCalledWith("status", expect.anything());
		await expect(harness.session.prompt("/clear")).rejects.toThrow("interactive terminal");
		await expect(harness.session.prompt("/allowed-tools")).rejects.toThrow("native features");
		expect(runner.getCommand("config:1")?.name).toBe("custom");
		const sourceInfo = { path: "/test/resource", source: "test", scope: "temporary", origin: "top-level" } as const;
		expect(
			getPromptCommands(
				[{ name: "clear", filePath: "/test/template.md", description: "", content: "template", sourceInfo }],
				commands,
			)[0].name,
		).toBe("prompt:clear");
		expect(
			getSkillCommands(
				[
					{
						name: "peers",
						description: "",
						filePath: "/test/SKILL.md",
						baseDir: "/test",
						disableModelInvocation: false,
						sourceInfo,
					},
				],
				commands,
			)[0].name,
		).toBe("skill:peers");
		expect(runner.getCommandDiagnostics().some((diagnostic) => diagnostic.message.includes("/config:1"))).toBe(true);
	} finally {
		harness.cleanup();
	}
});
