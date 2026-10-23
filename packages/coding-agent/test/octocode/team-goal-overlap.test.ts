import { describe, expect, it } from "vitest";
import type { Member } from "../../src/octocode/team/model.ts";
import { goalWords, overlapNote, selfAndAncestors, similarGoals } from "../../src/octocode/team/overlap.ts";

const member = (id: string, goal: string | undefined, parentId?: string): Member => ({
	id,
	role: parentId ? "researcher" : "main",
	...(parentId ? { parentId } : {}),
	pid: 1,
	status: "working",
	...(goal ? { goal } : {}),
	joinedAt: 0,
	updatedAt: 0,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	pending: 0,
});

const LIVE = "audit agent loop + context engineering";

describe("goal overlap", () => {
	it("ignores stop words and plural endings", () => {
		expect([...goalWords("Context engineering audit, RFC and fixes")].sort()).toEqual([
			"audit",
			"context",
			"engineering",
			"fix",
			"rfc",
		]);
	});

	it("finds the 2026-10-23 overlap and not an unrelated task", () => {
		expect(similarGoals("context engineering audit, RFC and fixes", LIVE)).toBe(true);
		expect(similarGoals("fix flaky tui test", LIVE)).toBe(false);
		expect(similarGoals("fix flaky tui test", "context engineering audit, RFC and fixes")).toBe(false);
		expect(similarGoals("audit auth", "audit tui")).toBe(false);
	});

	it("names the live agent and its session once per pair, never the launcher or its ancestors", () => {
		const members = [
			member("cheeky-kelp", "other work"),
			member("snappy-mantle", LIVE, "cheeky-kelp"),
			member("glowing-nautilus", "context engineering audit and fixes"),
		];
		const warned = new Set<string>();
		const self = selfAndAncestors("glowing-nautilus", members);
		const goal = "context engineering audit, RFC and fixes";
		expect(overlapNote(goal, members, self, warned)).toBe(
			"Similar goal already running: snappy-mantle (audit agent loop + context engineering) in session cheeky-kelp.",
		);
		expect(overlapNote(goal, members, self, warned)).toBe("");
		expect(overlapNote("fix flaky tui test", members, self, new Set())).toBe("");
	});
});
