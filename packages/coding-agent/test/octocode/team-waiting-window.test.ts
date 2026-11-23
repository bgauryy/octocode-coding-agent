import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { describe, expect, it } from "vitest";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";

const member: Member = {
	id: "recipient",
	role: "reviewer",
	pid: process.pid,
	status: "working",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
};

describe("waitingThrough window", () => {
	it("returns at most `limit` oldest ids, skips tracked ones, and leaves the rest for later calls", () => {
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			store.save(member);
			const ids = Array.from({ length: 6 }, (_, i) =>
				store.send("sender", ["recipient"], `m${i}`, { replyRequired: false }),
			);
			const flat = ids.flat().map((value) => (typeof value === "number" ? value : (value as { id: number }).id));
			const last = Math.max(...flat);
			const first = store.waitingThrough("recipient", last, new Set(), 2);
			expect(first).toHaveLength(2);
			// Tracked ids no longer fill the window, so later rows surface.
			const next = store.waitingThrough("recipient", last, new Set(first), 2);
			expect(next).toHaveLength(2);
			expect(next.every((id) => !first.includes(id))).toBe(true);
			const all = store.waitingThrough("recipient", last, new Set([...first, ...next]), 2);
			expect(all).toHaveLength(2);
			expect(store.waitingThrough("recipient", last, new Set([...first, ...next, ...all]), 2)).toEqual([]);
		} finally {
			store.close();
		}
	});
});
