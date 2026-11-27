import type { Member } from "@octocodeai/octocode-contracts/team";
import { describe, expect, it } from "vitest";
import { needsYou } from "../../src/octocode/team/panel/attention.ts";
import { FinishedTracker } from "../../src/octocode/team/panel/finished.ts";
import { WaitingApprovals } from "../../src/octocode/team/session/approvals.ts";
import { buildRoster } from "../../../webview/src/app/live/agent-roster.ts";

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: 1,
	status: "working",
	joinedAt: 0,
	updatedAt: 0,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

describe("Member.waiting, outcome and headline", () => {
	it("marks a member that waits for the user, whichever process wrote the row", () => {
		const other = member("far-otter", { waiting: "approval", pid: 4242 });
		expect([...needsYou([other, member("calm-heron")], [], "main-aaaaaa").entries()]).toEqual([
			["far-otter", { kind: "approval", count: 1 }],
		]);
		expect([...needsYou([member("q", { waiting: "reply" })], [], "main-aaaaaa").keys()]).toEqual(["q"]);
		expect(needsYou([other], [], undefined).size).toBe(0);
	});

	it("the host writes waiting and the finish outcome onto the members it lists, leaving the stored rows alone", () => {
		const approvals = new WaitingApprovals();
		const view = { members: [member("asker"), member("worker")] };
		approvals.set("asker", true);
		approvals.noteEnd("worker", { outcome: "blocked", headline: "needs a decision" });
		const listed = approvals.overlay(view).members;
		expect(listed[0]).toMatchObject({ waiting: "approval" });
		expect(listed[1]).toMatchObject({ outcome: "blocked", headline: "needs a decision" });
		expect(view.members[0]?.waiting).toBeUndefined();
		approvals.set("asker", false);
		expect(approvals.overlay(view).members[0]?.waiting).toBeUndefined();
	});

	it("keeps how a child ended from the host after its row left, and from a row that carries the outcome", () => {
		const approvals = new WaitingApprovals();
		const live = member("old-gecko");
		const tracker = new FinishedTracker((id) => approvals.endOf(id));
		tracker.update("main-aaaaaa", [live], [live], 1_000);
		tracker.update("main-aaaaaa", [], [], 2_000);
		expect(tracker.finished[0]?.end).toBeUndefined();
		approvals.noteEnd("old-gecko", { outcome: "failed", headline: "boom" });
		expect(tracker.finished[0]?.end).toEqual({ outcome: "failed", headline: "boom" });

		const carried = member("calm-wolf", { outcome: "done", headline: "all green" });
		const bare = new FinishedTracker();
		bare.update("main-aaaaaa", [carried], [carried], 1_000);
		bare.update("main-aaaaaa", [], [], 2_000);
		expect(bare.finished[0]?.end).toEqual({ outcome: "done", headline: "all green" });
	});

	it("the web roster puts a waiting agent first as needing attention", () => {
		const roster = buildRoster([member("a"), member("b", { waiting: "approval" })], []);
		expect(roster.map((node) => [node.agent.id, node.attention])).toEqual([
			["b", true],
			["a", false],
		]);
	});
});
