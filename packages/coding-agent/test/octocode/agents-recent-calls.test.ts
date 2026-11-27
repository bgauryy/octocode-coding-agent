import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { agentDetail } from "../../src/octocode/subagents/detail/content.ts";
import { recentCalls } from "../../src/octocode/subagents/detail/recent-calls.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(id: string, calls: Array<[string, Record<string, unknown>]>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recent-calls-"));
	dirs.push(dir);
	const lines = [
		{ type: "session", id, version: 3, timestamp: "2026-11-20T11:00:00Z", cwd: "/repo" },
		...calls.map(([name, args], index) => ({
			type: "message",
			id: `m${index}`,
			parentId: index ? `m${index - 1}` : null,
			timestamp: new Date(NOW - (calls.length - index) * 60_000).toISOString(),
			message: { role: "assistant", content: [{ type: "toolCall", id: `c${index}`, name, arguments: args }] },
		})),
	];
	fs.writeFileSync(
		path.join(dir, `2026-11-20T11-00-00-000Z_${id}.jsonl`),
		lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
	);
	return dir;
}

describe("recent tool calls", () => {
	it("lists the last five calls newest first from the child's transcript", () => {
		const dir = transcript(
			"s1",
			Array.from({ length: 7 }, (_, i): [string, Record<string, unknown>] => ["bash", { command: `cmd-${i}` }]),
		);
		const calls = recentCalls(dir, "s1");
		expect(calls.map((call) => call.args)).toEqual([
			"command=cmd-6",
			"command=cmd-5",
			"command=cmd-4",
			"command=cmd-3",
			"command=cmd-2",
		]);
	});

	it("is empty without a transcript file", () => {
		expect(recentCalls(os.tmpdir() + "/does-not-exist-recent", "s1")).toEqual([]);
	});

	it("shows on the agent page with the call's age", () => {
		const dir = transcript("s2", [["read", { path: "a.ts" }]]);
		const member = {
			id: "x",
			role: "r",
			pid: 1,
			status: "working",
			joinedAt: NOW,
			updatedAt: NOW,
			toolCalls: 1,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		} as Member;
		const detail = agentDetail({ member, now: NOW, traffic: [], calls: recentCalls(dir, "s2") });
		const row = detail.facts.find(([label]) => label === "recent calls");
		expect(row?.[1]).toContain("read path=a.ts");
		expect(row?.[1]).toMatch(/\(1m ago\)|ago/);
	});
});
