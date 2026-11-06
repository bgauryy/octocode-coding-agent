import { describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { AGENT_RESULT_TYPE } from "../../src/octocode/shared/messages.ts";
import { FORK_NOTE_TYPE, resumeNote } from "../../src/octocode/subagents/children.ts";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { WaitingApprovals, WAITING_APPROVAL } from "../../src/octocode/team/session/approvals.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { fakeHost } from "./fake-host.ts";

/** The `agent` tool result a session records for a background child that has not reported. */
const started = (id: string) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolName: "agent",
		toolCallId: `call-${id}`,
		content: [{ type: "text", text: `Started ${id} in the background` }],
		details: { id, profile: "general", goal: "work", status: "background", runId: `run-${id}`, startedAt: 1 },
	},
});

describe("the note a resumed session gets about children that ended with it", () => {
	it("names a child recorded background that does not run and left no report", () => {
		const note = resumeNote([started("gone-1")], new Set(), new Set());
		expect(note).toContain("[Resume]");
		expect(note).toContain("gone-1 (general");
		expect(note).toContain("`resume`");
	});

	it("leaves out a child that runs, one with a report waiting, and a session with none", () => {
		expect(resumeNote([started("alive")], new Set(), new Set(["alive"]))).toBeUndefined();
		expect(resumeNote([started("filed")], new Set(["filed"]), new Set())).toBeUndefined();
		expect(resumeNote([], new Set(), new Set())).toBeUndefined();
	});

	it("leaves out a child whose report arrived", () => {
		const reported = {
			type: "custom_message",
			customType: AGENT_RESULT_TYPE,
			content: "report",
			details: { id: "done-1", status: "done", runId: "run-done-1", startedAt: 1 },
		};
		expect(resumeNote([started("done-1"), reported], new Set(), new Set())).toBeUndefined();
	});

	it("does not name a child twice across restarts", () => {
		const first = resumeNote([started("gone-1")], new Set(), new Set())!;
		const told = { type: "custom_message", customType: FORK_NOTE_TYPE, content: first };
		expect(resumeNote([started("gone-1"), told], new Set(), new Set())).toBeUndefined();
		expect(resumeNote([started("gone-1"), told, started("gone-2")], new Set(), new Set())).toContain("gone-2 (");
	});
});

describe("report sends after the timed retries gave up", () => {
	const report = (id: string): Report => ({
		content: `Background subagent ${id} finished`,
		details: { id, status: "done", summary: "Done" },
		wake: true,
	});

	it("tells the user once, and sends again after the next settled turn", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeHost();
			const send = f.api.sendMessage;
			let down = true;
			f.api.sendMessage = (message, options) =>
				down ? Promise.reject(new Error("prepareRun failed")) : send(message, options);
			const warned: string[] = [];
			const queue = new ReportQueue(f.api, 60_000);
			queue.start(
				{
					getSessionFile: () => undefined,
					getEntries: () =>
						f.sent.map(({ message }, index) => ({
							...message,
							type: "custom_message" as const,
							id: String(index),
						})) as never,
				},
				() => true,
				(text) => warned.push(text),
			);
			queue.add(report("stuck"));
			queue.flush();
			// All six waits, generously.
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(warned).toEqual([expect.stringContaining("The report of stuck could not be delivered")]);
			expect(f.sent).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(warned).toHaveLength(1);

			down = false;
			queue.retryExhausted();
			await vi.advanceTimersByTimeAsync(0);
			expect(f.sent.map((entry) => entry.options.triggerTurn)).toEqual([true]);
			expect(queue.pendingIds().has("stuck")).toBe(false);
			queue.persist();
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a report still on its timed retries alone", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeHost();
			const send = f.api.sendMessage;
			let calls = 0;
			f.api.sendMessage = (message, options) => {
				calls++;
				return calls === 1 ? Promise.reject(new Error("once")) : send(message, options);
			};
			const queue = new ReportQueue(f.api, 60_000);
			queue.start({ getSessionFile: () => undefined, getEntries: () => [] });
			queue.add(report("soon"));
			queue.flush();
			await vi.advanceTimersByTimeAsync(0);
			queue.retryExhausted();
			expect(calls).toBe(1);
			queue.persist();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a child waiting for the user's answer", () => {
	const member = (id: string): Member => ({
		id,
		role: "general",
		pid: 1,
		status: "working",
		activity: "→ bash make",
		joinedAt: 0,
		updatedAt: 0,
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
	});

	it("reads as waiting for approval in the listing, and stops when answered", () => {
		const approvals = new WaitingApprovals();
		const view = { members: [member("asker"), member("worker")] };
		expect(approvals.overlay(view)).toBe(view);

		approvals.set("asker", true);
		const listed = describeMembers(approvals.overlay(view).members, undefined, 0);
		expect(listed).toContain(WAITING_APPROVAL);
		expect(listed.split("worker")[1]).toContain("→ bash make");
		// The view read from the database is not changed under its other readers.
		expect(view.members[0]?.activity).toBe("→ bash make");

		approvals.set("asker", false);
		expect(approvals.overlay(view)).toBe(view);
	});
});
