import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";

describe("slash command usage hints", () => {
	const hint = (name: string) => BUILTIN_SLASH_COMMANDS.find((command) => command.name === name)?.argumentHint;

	it("shows every form the handlers accept", () => {
		expect(hint("permissions")).toContain("plan [off]");
		expect(hint("providers")).toContain("runner:<id>");
	});
});
