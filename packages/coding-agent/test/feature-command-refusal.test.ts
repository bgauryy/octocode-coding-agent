import { describe, expect, it } from "vitest";
import type { FeatureHost } from "../src/core/features/index.ts";
import { isCommandLine, tryExecuteFeatureCommand } from "../src/core/agent-session/prompt-expansion.ts";

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

describe("a moved name", () => {
	it("runs its replacement once, with its arguments", async () => {
		const ran: string[] = [];
		const harness = { handler: async (args: string) => void ran.push(args) };
		const runner = runnerWith({ harness });
		expect(await tryExecuteFeatureCommand(runner, "/plugins disable x")).toBe(true);
		expect(await tryExecuteFeatureCommand(runner, "/hooks events")).toBe(true);
		expect(ran).toEqual(["disable x", "hooks events"]);
	});
});

describe("a line prompt() settles without the model", () => {
	it("is a registered command, a built-in or a switched-off feature's command; other text is a model prompt", () => {
		const handler = async () => undefined;
		const runner = runnerWith({ backlog: { handler }, harness: { handler } });
		expect(isCommandLine(runner, "/backlog")).toBe(true);
		expect(isCommandLine(runner, "/backlog add Fix it")).toBe(true);
		expect(isCommandLine(runner, "/plugins disable x")).toBe(true);
		expect(isCommandLine(runner, "/help")).toBe(true);
		expect(isCommandLine(runner, "/mcp tools")).toBe(true);
		expect(isCommandLine(runner, "/skill:review")).toBe(false);
		expect(isCommandLine(runner, "/nosuch")).toBe(false);
		expect(isCommandLine(runner, " /backlog")).toBe(false);
		expect(isCommandLine(runner, "backlog")).toBe(false);
	});
});
