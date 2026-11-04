import { describe, expect, it } from "vitest";
import type { ExtensionRunner } from "../src/core/features/index.ts";
import { tryExecuteExtensionCommand } from "../src/core/agent-session/prompt-expansion.ts";

const runnerWith = (commands: Record<string, unknown> = {}): ExtensionRunner =>
	({
		getCommand: (name: string) => commands[name],
		createCommandContext: () => ({}),
		emitError: () => undefined,
	}) as unknown as ExtensionRunner;

describe("a command of a built-in feature that is off", () => {
	it("is refused, not sent to the model", async () => {
		await expect(tryExecuteExtensionCommand(runnerWith(), "/mcp tools")).rejects.toThrow(
			"/mcp is unavailable: the mcp feature is off.",
		);
		await expect(tryExecuteExtensionCommand(runnerWith(), "/llama")).rejects.toThrow(
			"/llama is unavailable: the llama.cpp feature is off.",
		);
	});

	it("runs when the feature registered it, and other unknown names still pass through", async () => {
		let ran = "";
		const handler = async (args: string) => {
			ran = args;
		};
		expect(await tryExecuteExtensionCommand(runnerWith({ mcp: { handler } }), "/mcp tools")).toBe(true);
		expect(ran).toBe("tools");
		expect(await tryExecuteExtensionCommand(runnerWith(), "/nosuch")).toBe(false);
	});
});
