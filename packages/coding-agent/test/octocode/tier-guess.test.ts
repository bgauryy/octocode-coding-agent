import { describe, expect, it } from "vitest";
import { indexCatalog, lookup } from "../../src/octocode/subagents/catalog.ts";
import { type ModelRef, MODEL_TIERS, resolveTierChoice, routeModel } from "../../src/octocode/subagents/model.ts";
import { guessSizeClass } from "../../src/octocode/subagents/size-class.ts";

const ref = (id: string, extra: Partial<ModelRef> = {}): ModelRef => ({
	provider: "p",
	id,
	contextWindow: 400_000,
	input: ["text", "image"],
	...extra,
});

describe("guessSizeClass", () => {
	it("reads the id family first, then the output limit and the window", () => {
		expect(guessSizeClass({ id: "claude-haiku-5" })).toBe("small");
		expect(guessSizeClass({ id: "openai/gpt-5-mini" })).toBe("small");
		expect(guessSizeClass({ id: "gemini-3-flash" })).toBe("small");
		expect(guessSizeClass({ id: "gpt-5-nano" })).toBe("small");
		expect(guessSizeClass({ id: "claude-opus-5" })).toBe("large");
		expect(guessSizeClass({ id: "gemini-3-pro" })).toBe("large");
		expect(guessSizeClass({ id: "mystery", context: 1_000_000, output: 64_000 })).toBe("medium");
		expect(guessSizeClass({ id: "mystery", output: 4_096 })).toBe("small");
		expect(guessSizeClass({ id: "mystery", context: 128_000 })).toBe("small");
		// A word inside another word is not a family: "promise" is no pro, "minimal" no mini.
		expect(guessSizeClass({ id: "promise-minimal" })).toBe("medium");
	});
});

describe("tiers for a parent with no price", () => {
	const parent = ref("mystery-xl");
	const haiku = ref("claude-haiku-5");
	const mini = ref("gpt-5-mini", { provider: "q" });
	const opus = ref("claude-opus-5");

	it("has the three tiers", () => {
		expect([...MODEL_TIERS]).toEqual(["small", "medium", "large"]);
	});

	it("picks a smaller size class than the parent and marks it a guess", () => {
		expect(resolveTierChoice("small", [parent, haiku, opus], parent)).toEqual({ model: haiku, guessed: true });
		// The provider of the parent ranks first, as with prices.
		expect(resolveTierChoice("small", [parent, mini, haiku], parent).model).toBe(haiku);
	});

	it("stays on the parent when nothing is smaller, without claiming a guess", () => {
		expect(resolveTierChoice("medium", [parent, haiku, opus], parent)).toEqual({ model: undefined, guessed: false });
		expect(resolveTierChoice("small", [parent, opus], parent)).toEqual({ model: undefined, guessed: false });
		const bigParent = ref("claude-opus-5");
		expect(resolveTierChoice("medium", [bigParent, ref("claude-sonnet-5")], bigParent).model?.id).toBe(
			"claude-sonnet-5",
		);
	});

	it("leaves a priced parent to its prices", () => {
		const priced = ref("claude-opus-5", { cost: { input: 5, output: 25 } });
		const cheap = ref("claude-haiku-5", { cost: { input: 0.5, output: 2 } });
		expect(resolveTierChoice("small", [priced, cheap], priced)).toEqual({ model: cheap, guessed: false });
	});

	it("resolves large to the parent, or the strongest connected model without one", () => {
		expect(resolveTierChoice("large", [parent, opus], parent)).toEqual({ model: undefined, guessed: false });
		expect(resolveTierChoice("large", [haiku, opus, ref("other")], undefined)).toEqual({ model: opus, guessed: true });
		expect(resolveTierChoice("large", [], undefined).model).toBeUndefined();
		expect(resolveTierChoice("small", [haiku], undefined).model).toBeUndefined();
	});

	it("reports the guess in the route and keeps large on the parent", () => {
		expect(routeModel({ preferred: "small", available: [parent, haiku], parent })).toEqual({
			model: "p/claude-haiku-5",
			guessed: true,
		});
		expect(routeModel({ preferred: "large", available: [parent, opus], parent })).toEqual({ model: "p/mystery-xl" });
		expect(routeModel({ preferred: "large:high", available: [haiku, opus], parent: undefined })).toEqual({
			model: "p/claude-opus-5:high",
			guessed: true,
		});
	});
});

describe("catalog facts", () => {
	it("keeps the output limit, cache prices and reasoning options", () => {
		const catalog = indexCatalog(
			{
				anthropic: {
					models: {
						"claude-x": {
							tool_call: true,
							reasoning: true,
							limit: { context: 200_000, output: 64_000 },
							cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
							reasoning_options: [{ type: "effort", values: ["low", "high"] }, { type: "bogus" }, 7],
						},
						"claude-y": { tool_call: true, limit: { context: 100_000, output: 0 }, cost: { input: 1, output: 2 } },
					},
				},
			},
			1,
		);
		const x = lookup(catalog, "anthropic", "claude-x");
		expect(x?.output).toBe(64_000);
		expect(x?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(x?.reasoningOptions).toEqual([{ type: "effort", values: ["low", "high"] }, { type: "bogus" }]);
		const y = lookup(catalog, "anthropic", "claude-y");
		expect(y?.output).toBeUndefined();
		expect(y?.cost).toEqual({ input: 1, output: 2 });
		expect(y?.reasoningOptions).toBeUndefined();
	});
});
