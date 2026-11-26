import { describe, expect, it } from "vitest";
import { leanMainPolicy } from "../src/core/lean-main.ts";

const model = (contextWindow: number) => ({ provider: "p", id: "m", contextWindow });
const auto = { leanPrompt: "auto" as const, subagents: undefined };

describe("leanPrompt auto by window", () => {
	it("gives 64k-class windows the lean policy", () => {
		expect(leanMainPolicy(model(64_000), auto)).toBe(true);
		expect(leanMainPolicy(model(65_536), auto)).toBe(true);
	});

	it("gives 128k and 200k windows the full policy", () => {
		expect(leanMainPolicy(model(128_000), auto)).toBe(false);
		expect(leanMainPolicy(model(200_000), auto)).toBe(false);
	});
});
