import { expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";
import { getPromptCommands } from "../src/core/prompt-templates.ts";
import { getSkillCommands } from "../src/core/skill-commands.ts";
import { NATIVE_FEATURE_PATH } from "../src/core/native-tools.ts";

it("gives each command one name, refuses aliases and keeps colliding extensions, skills and prompts reachable", async () => {
	const native = vi.fn(async () => {});
	const extension = vi.fn(async () => {});
	let refused: unknown;
	const harness = await createHarness({
		extensionFactories: [
			{
				path: NATIVE_FEATURE_PATH,
				factory: (api) => {
					api.registerCommand("agents", { handler: native });
				},
			},
			(api) => {
				api.registerCommand("agents", { handler: extension });
				api.registerCommand("clear", { handler: extension });
				try {
					api.registerCommand("custom", { aliases: ["config"], handler: extension } as never);
				} catch (error) {
					refused = error;
				}
			},
		],
	});
	try {
		expect(String(refused)).toContain("aliases, which are no longer supported");
		const runner = harness.session.extensionRunner;
		expect(runner.getCommand("custom")).toBeUndefined();
		expect(runner.getCommand("config")).toBeUndefined();
		expect(runner.getCommand("agents")?.handler).toBe(native);
		for (const removed of ["peers", "list-agents"]) expect(runner.getCommand(removed)).toBeUndefined();
		const commands = runner.getRegisteredCommands();
		const qualified = commands.find((command) => command.name === "agents" && command.handler === extension)!;
		expect(qualified.invocationName).toMatch(/^agents:\d+$/);
		expect(Object.keys(qualified)).not.toContain("invocationAliases");
		await harness.session.prompt(`/${qualified.invocationName} status`);
		expect(extension).toHaveBeenCalledWith("status", expect.anything());
		// `/clear` is no longer a built-in spelling, so an extension may own it.
		expect(runner.getCommand("clear")?.handler).toBe(extension);
		await harness.session.prompt("/clear now");
		expect(extension).toHaveBeenCalledWith("now", expect.anything());
		await expect(harness.session.prompt("/permissions")).rejects.toThrow("native features");
		const sourceInfo = { path: "/test/resource", source: "test", scope: "temporary", origin: "top-level" } as const;
		expect(
			getPromptCommands(
				[
					{ name: "clear", filePath: "/test/clear.md", description: "", content: "template", sourceInfo },
					{ name: "config", filePath: "/test/config.md", description: "", content: "template", sourceInfo },
					{ name: "new", filePath: "/test/new.md", description: "", content: "template", sourceInfo },
				],
				commands,
			).map((command) => command.name),
		).toEqual(["prompt:clear", "config", "prompt:new"]);
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
		).toBe("peers");
		expect(runner.getCommandDiagnostics().map((diagnostic) => diagnostic.message)).toEqual([
			`Command /agents conflicts with another command; available as /${qualified.invocationName}.`,
		]);
	} finally {
		harness.cleanup();
	}
});
