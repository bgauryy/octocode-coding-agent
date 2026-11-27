import { expect, it } from "vitest";
import { Type } from "typebox";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

const base = { name: "t", label: "t", description: "t", parameters: Type.Object({}) };
const execute = async () => ({ content: [], details: {} });

it("forwards a definition's per-call concurrency to the agent tool", () => {
	const resolver = (args: Record<string, unknown>) => (args.write ? ("exclusive" as const) : ("shared" as const));
	expect(wrapToolDefinition({ ...base, concurrency: resolver, execute }).concurrency).toBe(resolver);
	expect(wrapToolDefinition({ ...base, concurrency: "exclusive", execute }).concurrency).toBe("exclusive");
});

it("keeps an agent tool's concurrency when it becomes a definition", () => {
	expect(createToolDefinitionFromAgentTool({ ...base, concurrency: "exclusive", execute }).concurrency).toBe(
		"exclusive",
	);
});
