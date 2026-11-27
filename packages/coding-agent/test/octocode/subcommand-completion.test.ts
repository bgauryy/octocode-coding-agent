import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { droppedLeadingWords, registeredCommands } from "./completion-driver.ts";

let registered: Awaited<ReturnType<typeof registeredCommands>>;
beforeAll(async () => {
	registered = await registeredCommands();
});
afterAll(() => registered?.dispose());

describe("second-level completion keeps the words before it", () => {
	it("registers commands with completion to drive", () => {
		const withCompletion = [...registered.commands.values()].filter((command) => command.getArgumentCompletions);
		expect(withCompletion.length).toBeGreaterThan(10);
	});

	it("returns the full argument text for every registered command", async () => {
		const failures: string[] = [];
		for (const [name, command] of registered.commands)
			for (const dropped of await droppedLeadingWords(command)) failures.push(`/${name} ${dropped}`);
		expect(failures).toEqual([]);
	});
});
