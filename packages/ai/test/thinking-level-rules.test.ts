import { describe, expect, it } from "vitest";
import { applyThinkingLevelRules, inferThinkingLevelMap } from "../src/utils/thinking-level-rules.ts";

const base = { provider: "p", api: "openai-responses", reasoning: true } as const;

describe("thinking level rules", () => {
	it("infers the map the generator would apply", () => {
		const model = { ...base, id: "gpt-5.5-pro", thinkingLevelMap: undefined } as never;
		const inferred = inferThinkingLevelMap(model);
		const applied = { ...(model as object) } as { thinkingLevelMap?: unknown };
		applyThinkingLevelRules(applied as never);
		expect(inferred).toEqual(applied.thinkingLevelMap);
		expect(inferred).toMatchObject({ off: null, minimal: null, low: null, xhigh: "xhigh" });
	});

	it("returns nothing for a non-reasoning model or one that has a map", () => {
		expect(inferThinkingLevelMap({ ...base, id: "gpt-5.5", reasoning: false })).toBeUndefined();
		expect(inferThinkingLevelMap({ ...base, id: "gpt-5.5", thinkingLevelMap: {} })).toBeUndefined();
	});
});
