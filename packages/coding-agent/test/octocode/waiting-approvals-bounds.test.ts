import { describe, expect, it } from "vitest";
import { WaitingApprovals } from "../../src/octocode/team/session/approvals.ts";

const member = (id: string) => ({ id }) as never;

describe("WaitingApprovals output tracking", () => {
	it("keeps the last-output time of recently active children and forgets the oldest in a long session", () => {
		const approvals = new WaitingApprovals();
		for (let i = 0; i < 1000; i++) approvals.noteOutput(`agent-${i}`, i);
		const view = approvals.overlay({ members: [member("agent-0"), member("agent-999")] });
		expect((view.members[1] as { lastOutputAt?: number }).lastOutputAt).toBe(999);
		expect((view.members[0] as { lastOutputAt?: number }).lastOutputAt).toBeUndefined();
	});

	it("a child that writes again stays among the kept ones", () => {
		const approvals = new WaitingApprovals();
		approvals.noteOutput("first", 1);
		for (let i = 0; i < 127; i++) approvals.noteOutput(`a-${i}`, 2);
		approvals.noteOutput("first", 3);
		approvals.noteOutput("late", 4);
		const view = approvals.overlay({ members: [member("first")] });
		expect((view.members[0] as { lastOutputAt?: number }).lastOutputAt).toBe(3);
	});
});
