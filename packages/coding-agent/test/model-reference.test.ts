import { describe, expect, it } from "vitest";
import {
	ModelReferenceError,
	parseModelReference,
	splitThinkingSuffix,
	tryParseModelReference,
} from "../src/core/model-reference.ts";

describe("model reference grammar", () => {
	it.each([
		["claude-sonnet", { id: "claude-sonnet", glob: false }],
		["anthropic/claude-sonnet", { provider: "anthropic", id: "claude-sonnet", glob: false }],
		[
			"anthropic/claude-sonnet:high",
			{ provider: "anthropic", id: "claude-sonnet", thinkingLevel: "high", glob: false },
		],
		["claude-sonnet:low", { id: "claude-sonnet", thinkingLevel: "low", glob: false }],
		["openrouter/qwen/qwen3-coder:exacto", { provider: "openrouter", id: "qwen/qwen3-coder:exacto", glob: false }],
		["anthropic/*", { provider: "anthropic", id: "*", glob: true }],
		["*sonnet*:max", { id: "*sonnet*", thinkingLevel: "max", glob: true }],
		["  openai/gpt-5  ", { provider: "openai", id: "gpt-5", glob: false }],
	])("parses %s", (text, expected) => {
		expect(parseModelReference(text)).toEqual(expected);
	});

	it.each([[""], ["   "], ["/gpt-5"], ["openai/"], ["openai/:high"]])("rejects %j", (text) => {
		expect(() => parseModelReference(text)).toThrow(ModelReferenceError);
		expect(tryParseModelReference(text)).toBeUndefined();
	});

	it("reads a level only as the last segment", () => {
		expect(splitThinkingSuffix("a/b:high")).toEqual({ base: "a/b", thinkingLevel: "high" });
		expect(splitThinkingSuffix("a/b:nope")).toBeUndefined();
		expect(splitThinkingSuffix(":high")).toBeUndefined();
	});
});
