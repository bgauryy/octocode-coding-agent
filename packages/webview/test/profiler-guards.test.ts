import { expect, it } from "vitest";
import { isProfileAgent } from "../src/profiler-guards.ts";
import { agent } from "./profiler-fixtures.ts";

it("accepts agents with or without an outcome and rejects a malformed one", () => {
	expect(isProfileAgent(agent("kid", { parentId: "main", outcome: "done" }))).toBe(true);
	expect(isProfileAgent(agent("kid"))).toBe(true);
	expect(isProfileAgent({ ...agent("kid"), outcome: 3 })).toBe(false);
});

it("validates the optional live fields when present", () => {
	expect(
		isProfileAgent(
			agent("kid", { contextTokens: 5, contextWindow: 100, activity: { kind: "request", label: "m", since: 1 } }),
		),
	).toBe(true);
	expect(isProfileAgent({ ...agent("kid"), contextTokens: "5" })).toBe(false);
});
