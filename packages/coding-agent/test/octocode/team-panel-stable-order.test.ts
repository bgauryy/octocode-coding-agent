import { describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { roster } from "../../src/octocode/team/panel/roster.ts";

const NOW = 1_000_000;
const ME = "main-aaaaaa";
const member = (id: string, joinedAt: number, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	parentId: ME,
	status: "working",
	joinedAt,
	updatedAt: NOW,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	goal: "g",
	...extra,
});
const main = member(ME, 0, { parentId: undefined, status: "idle" });
const approval = (id: string) => new Map([[id, { kind: "approval" as const, count: 1 }]]);
const ids = (members: Member[], needs?: Map<string, { kind: "approval"; count: number }>) =>
	roster([main, ...members], ME, NOW, [], needs).tree.map((entry) => entry.member.id);

describe("agents panel: rows keep their position", () => {
	it("orders children by start, whatever their state", () => {
		const first = member("first-0001", 1_000, { status: "idle" });
		const second = member("second-0002", 2_000);
		const third = member("third-0003", 3_000, { waiting: "approval" });
		expect(ids([first, second, third], approval("third-0003"))).toEqual(["first-0001", "second-0002", "third-0003"]);
	});

	it("does not move a branch when a grandchild starts waiting", () => {
		const quiet = member("quiet-0001", 1_000);
		const parent = member("parent-0002", 2_000);
		const before = ids([quiet, parent, member("child-0003", 3_000, { parentId: "parent-0002" })]);
		const after = ids(
			[quiet, parent, member("child-0003", 3_000, { parentId: "parent-0002", waiting: "approval" })],
			approval("child-0003"),
		);
		expect(after).toEqual(before);
		expect(before).toEqual(["quiet-0001", "parent-0002", "child-0003"]);
	});

	it("keeps a finished child where it was among its siblings", () => {
		const a = member("a-0001", 1_000);
		const b = member("b-0002", 2_000);
		const finished = [{ member: b, at: NOW - 1_000 }];
		const out = roster([main, a], ME, NOW, finished as never).tree.map((entry) => entry.member.id);
		expect(out).toEqual(["a-0001", "b-0002"]);
	});
});
