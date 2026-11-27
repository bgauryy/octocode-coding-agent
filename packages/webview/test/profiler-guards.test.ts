import { expect, it } from "vitest";
import { isProfileAgent, isProfileRequest } from "../src/profiler-guards.ts";
import { agent, request } from "./profiler-fixtures.ts";

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

it("accepts requests with a cache group and provider miss reason and rejects malformed ones", () => {
	const group = { key: "k", prefix: "0123456789abcdef" };
	expect(isProfileRequest(request("kid", 0, { cacheGroup: group, providerMissReason: "tools_changed" }))).toBe(true);
	expect(isProfileRequest(request("kid", 0, { cacheGroup: { prefix: "x" } }))).toBe(true);
	expect(isProfileRequest({ ...request("kid", 0), cacheGroup: { key: "k" } })).toBe(false);
	expect(isProfileRequest({ ...request("kid", 0), providerMissReason: 3 })).toBe(false);
	expect(isProfileAgent(agent("kid", { cacheGroup: group }))).toBe(true);
	expect(isProfileAgent({ ...agent("kid"), cacheGroup: "k" })).toBe(false);
});
