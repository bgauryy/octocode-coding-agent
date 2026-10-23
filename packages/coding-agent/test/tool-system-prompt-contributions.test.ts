import { describe, expect, test } from "vitest";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";

describe("built-in tool system prompt contributions", () => {
	test("keeps the bash tool definition aligned with its contribution", () => {
		const definition = createBashToolDefinition("/workspace");

		expect(definition.promptSnippet).toBe(bashToolSystemPromptContribution.snippet);
		expect(definition.promptGuidelines ?? []).toEqual(bashToolSystemPromptContribution.guidelines);
	});

	test("keeps bash session-environment guidance conditional", () => {
		const definition = createBashToolDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});
});
