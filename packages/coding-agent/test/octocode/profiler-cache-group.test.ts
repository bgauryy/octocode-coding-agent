import { describe, expect, it } from "vitest";
import { agentRow, deriveRequests, prepare, type Entry } from "../../src/octocode/profiler/index.ts";
import { CACHE_GROUP_ENTRY } from "../../src/octocode/shared/cache-group-entry.ts";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

function transcript(groups: Array<Record<string, unknown> | undefined>, diagnostics?: unknown[]): Entry[] {
	const entries: Entry[] = [{ type: "session", id: "s", cwd: "/x" }];
	let parent = "s";
	groups.forEach((group, at) => {
		if (group) {
			entries.push({
				type: "custom",
				id: `g${at}`,
				parentId: parent,
				customType: CACHE_GROUP_ENTRY,
				data: group,
			});
			parent = `g${at}`;
		}
		entries.push({
			type: "message",
			id: `a${at}`,
			parentId: parent,
			timestamp: new Date(1_000_000 + at * 1000).toISOString(),
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				content: "x",
				usage: { ...usage },
				...(diagnostics && at === 0 ? { diagnostics } : {}),
			},
		});
		parent = `a${at}`;
	});
	return entries;
}

describe("profiler cache group", () => {
	it("carries the group in force and the provider's miss reason per request", () => {
		const entries = transcript(
			[{ version: 1, key: "k1", prefix: "aaaa" }, undefined, { version: 1, prefix: "bbbb" }],
			[{ type: "cache_miss", details: { reason: "tools_changed" } }],
		);
		const prepared = prepare(entries);
		const rows = deriveRequests(entries, { agentId: "kid", prepared });
		expect(rows.map((row) => row.cacheGroup)).toEqual([
			{ key: "k1", prefix: "aaaa" },
			{ key: "k1", prefix: "aaaa" },
			{ prefix: "bbbb" },
		]);
		expect(rows[0].providerMissReason).toBe("tools_changed");
		expect(rows[1].providerMissReason).toBeUndefined();
		expect(agentRow({ id: "kid", role: "x", status: "idle" }, prepared).cacheGroup).toEqual({ prefix: "bbbb" });
	});

	it("omits both fields for a transcript that recorded neither", () => {
		const entries = transcript([undefined]);
		const [row] = deriveRequests(entries, { agentId: "main", prepared: prepare(entries) });
		expect(row).not.toHaveProperty("cacheGroup");
		expect(row).not.toHaveProperty("providerMissReason");
	});

	it("ignores a malformed group entry", () => {
		const entries = transcript([{ version: 2, prefix: "zz" }]);
		expect(deriveRequests(entries, { agentId: "k", prepared: prepare(entries) })[0]).not.toHaveProperty("cacheGroup");
	});
});
