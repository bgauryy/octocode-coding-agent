import { describe, expect, it } from "vitest";
import type { FeatureHost } from "../src/core/features/index.ts";
import { tryExecuteFeatureCommand } from "../src/core/agent-session/prompt-expansion.ts";

const runnerWith = (commands: Record<string, unknown> = {}): FeatureHost =>
	({
		getCommand: (name: string) => commands[name],
		createCommandContext: () => ({}),
		emitError: () => undefined,
	}) as unknown as FeatureHost;

describe("a command of a built-in feature that is off", () => {
	it("is refused, not sent to the model", async () => {
		await expect(tryExecuteFeatureCommand(runnerWith(), "/mcp tools")).rejects.toThrow(
			"/mcp is unavailable: the mcp feature is off.",
		);
	});

	it("runs when the feature registered it, and other unknown names still pass through", async () => {
		let ran = "";
		const handler = async (args: string) => {
			ran = args;
		};
		expect(await tryExecuteFeatureCommand(runnerWith({ mcp: { handler } }), "/mcp tools")).toBe(true);
		expect(ran).toBe("tools");
		expect(await tryExecuteFeatureCommand(runnerWith(), "/nosuch")).toBe(false);
	});
});
