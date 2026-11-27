import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("built-in slash command descriptions", () => {
	it.each(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command.description] as const))(
		"/%s has a short description",
		(_name, description) => {
			expect(description.trim()).not.toBe("");
			expect(description.length).toBeLessThanOrEqual(50);
			expect(description).not.toMatch(/ — | · /);
		},
	);
});
