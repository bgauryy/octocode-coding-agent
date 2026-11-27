import { describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { idleWaitReporter, idleWaitText } from "../../src/octocode/subagents/idle-wait.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { WaitingApprovals } from "../../src/octocode/team/session/approvals.ts";

const idle = { waits: 2, settling: true, toolsRunning: 0, workWaits: [], replies: [] } as Parameters<
	typeof idleWaitText
>[0];
const NOW = 1_000_000;
const member = (extra: Partial<Member> = {}): Member => ({
	id: "warm-carp",
	role: "implementer",
	pid: process.pid,
	status: "idle",
	joinedAt: NOW - 60_000,
	updatedAt: NOW,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

describe("idleWaitText", () => {
	it("names the notify, job and reply an answered child idles on", () => {
		const text = idleWaitText({
			...idle,
			workWaits: [
				{ kind: "timer", call: 1, id: 13 },
				{ kind: "job", call: 2, id: "task-4" },
			],
			replies: [{ id: 22, to: ["hardy-scallop"] }],
		});
		expect(text).toBe("notify 13; job task-4; reply #22 from hardy-scallop");
	});

	it("says nothing while the child works, runs a tool or waits on nothing", () => {
		expect(idleWaitText({ ...idle, settling: false })).toBeUndefined();
		expect(idleWaitText({ ...idle, toolsRunning: 1 })).toBeUndefined();
		expect(idleWaitText({ ...idle, waits: 0 })).toBeUndefined();
	});

	it("reports only changes, and the end of the wait", () => {
		const report = vi.fn();
		const update = idleWaitReporter(report);
		const waiting = { ...idle, replies: [{ id: 1, to: [] }] };
		update(waiting);
		update(waiting);
		update({ ...waiting, settling: false });
		expect(report.mock.calls).toEqual([["reply #1"], [undefined]]);
	});
});

describe("a child idle on its own wait in the team views", () => {
	it("overlays waitingOn on an idle member only", () => {
		const approvals = new WaitingApprovals();
		approvals.noteIdleWait("warm-carp", "notify 13");
		const [idleRow] = approvals.overlay({ members: [member()] }).members;
		expect(idleRow.waitingOn).toBe("notify 13");
		expect(idleRow.activity).toBe("waiting on notify 13");
		const [busy] = approvals.overlay({ members: [member({ status: "working" })] }).members;
		expect(busy.waitingOn).toBeUndefined();
		approvals.noteIdleWait("warm-carp", undefined);
		expect(approvals.overlay({ members: [member()] }).members[0].waitingOn).toBeUndefined();
	});

	it("lists it as waiting on the condition, not idle", () => {
		const text = describeMembers([member({ waitingOn: "reply #22" })], "main", NOW);
		expect(text).toContain("waiting on reply #22");
		expect(text).toContain("waiting");
		expect(describeMembers([member()], "main", NOW)).not.toContain("waiting on");
	});
});
