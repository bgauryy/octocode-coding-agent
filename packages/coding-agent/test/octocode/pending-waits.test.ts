import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE_TYPE, JOB_TYPE, TIMER_TYPE } from "../../src/octocode/shared/messages.ts";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import { heartbeatDue } from "../../src/octocode/subagents/liveness.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";

const limits = { idleMs: 1_000, busyMs: 5_000 };
const start = (toolName: string, args: unknown, toolCallId: string) => ({
	type: "tool_execution_start",
	toolName,
	args,
	toolCallId,
});
const end = (toolName: string, _args: unknown, toolCallId: string, details: unknown, isError = false) => ({
	type: "tool_execution_end",
	toolName,
	toolCallId,
	isError,
	result: { content: [], details },
});
const notice = (customType: string, details: unknown) => ({
	type: "message_end",
	message: { role: "custom", customType, details, content: "completed" },
});
const timerArgs = { op: "set", every: 30, note: "Keep checking" };
const messageArgs = { type: "message", to: "peer", replyRequired: true };

function setup() {
	const state = newChildState();
	const apply = (event: Record<string, unknown>) => reduceEvent(state, event, limits, 100_000);
	const timer = (id: number) => {
		apply(start("timer", timerArgs, `timer-${id}`));
		apply(end("timer", timerArgs, `timer-${id}`, { timer: { id, kind: "every", status: "active" } }));
	};
	const message = () => {
		apply(start("agent", messageArgs, "send-1"));
		apply(end("agent", messageArgs, "send-1", { id: 42, to: ["peer"] }));
	};
	return { state, apply, timer, message };
}

describe("a child's pending work identities", () => {
	it.each([false, true])("tracks a returned background job once (explicit background: %s)", (background) => {
		const { state, apply } = setup();
		const args = { command: "sleep 100", ...(background ? { background } : {}) };
		apply(start("bash", args, "bash-1"));
		apply(end("bash", args, "bash-1", { job: "job-1", log: "/tmp/job-1.log", moved: !background }));
		expect(state.waits).toBe(1);
		apply(notice(JOB_TYPE, { id: "job-1", log: "/tmp/job-1.log" }));
		expect(state.waits).toBe(0);
	});

	it("does not add a wait for a completed foreground call or a failed background start", () => {
		const { state, apply } = setup();
		apply(start("bash", { command: "true" }, "foreground"));
		apply(end("bash", { command: "true" }, "foreground", { exitCode: 0 }));
		expect(state.waits).toBe(0);
		apply(start("bash", { background: true }, "failed"));
		apply(end("bash", { background: true }, "failed", {}, true));
		expect(state.waits).toBe(0);
		apply(end("bash", { command: "sleep 100" }, "failed-handoff", { job: "job-1" }, true));
		expect(state.waits).toBe(0);
	});

	it("an unrelated notice cannot reset a lone background job's declared deadline", () => {
		const { state, apply } = setup();
		const args = { background: true, timeout: 60 };
		apply(start("bash", args, "bash-1"));
		apply(end("bash", args, "bash-1", { job: "job-1" }));
		apply(notice(JOB_TYPE, { id: "old-job" }));
		expect(state.waits).toBe(1);
		expect(state.jobsUntil).toBe(160_000);
	});

	it.each(["reply", "timer"])("clears a completed job's deadlines while an unrelated %s remains", (remaining) => {
		const { state, apply, message, timer } = setup();
		state.running = true;
		if (remaining === "reply") message();
		else timer(1);
		const args = { background: true, timeout: 600 };
		apply(start("bash", args, "bash-1"));
		apply(end("bash", args, "bash-1", { job: "job-1", log: "/tmp/job-1.log" }));
		expect(heartbeatDue(state, 101_000, false)).toBe(true);
		apply(notice(JOB_TYPE, { id: "job-1", log: "/tmp/job-1.log" }));
		expect(state.waits).toBe(1);
		expect(state.jobsUntil).toBe(0);
		expect(state.jobsMs).toBe(0);
		expect(heartbeatDue(state, 101_000, false)).toBe(false);
		apply({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Waiting for the reply." }] },
		});
		expect(state.busyUntil).toBe(106_000);
	});

	it("uses only the remaining job's timeout after the longest job finishes", () => {
		const { state, apply } = setup();
		state.running = true;
		for (const timeout of [60, 600]) {
			const args = { background: true, timeout };
			apply(start("bash", args, `bash-${timeout}`));
			apply(end("bash", args, `bash-${timeout}`, { job: `job-${timeout}` }));
		}
		apply(notice(JOB_TYPE, { id: "job-600" }));
		expect(state.waits).toBe(1);
		expect(state.jobsUntil).toBe(160_000);
		expect(state.jobsMs).toBe(60_000);
		expect(heartbeatDue(state, 159_999, false)).toBe(true);
		expect(heartbeatDue(state, 160_000, false)).toBe(false);
		apply(notice(JOB_TYPE, { id: "job-60" }));
		expect(state.jobsUntil).toBe(0);
		expect(state.jobsMs).toBe(0);
	});

	it("removes a failed background start's timeout without consuming a pending reply", () => {
		const { state, apply, message } = setup();
		state.running = true;
		message();
		const args = { background: true, timeout: 600 };
		apply(start("bash", args, "failed"));
		apply(end("bash", args, "failed", {}, true));
		expect(state.waits).toBe(1);
		expect(state.jobsUntil).toBe(0);
		expect(state.jobsMs).toBe(0);
		expect(heartbeatDue(state, 101_000, false)).toBe(false);
	});

	it("drops a finished foreground call's deadline while another call is still running", () => {
		const state = newChildState();
		state.running = true;
		const short = { command: "sleep 60", timeout: 60 };
		const long = { command: "sleep 600", timeout: 600 };
		reduceEvent(state, start("bash", short, "short"), limits, 100_000);
		reduceEvent(state, start("bash", long, "long"), limits, 101_000);
		reduceEvent(state, end("bash", long, "long", { exitCode: 0 }), limits, 102_000);
		expect(state.toolsRunning).toBe(1);
		expect(state.declaredUntil).toBe(160_000);
		expect(heartbeatDue(state, 160_000, false)).toBe(false);
	});

	it("preserves the original declared deadline when a foreground call moves to the background", () => {
		const state = newChildState();
		state.running = true;
		const args = { command: "sleep 60", timeout: 60 };
		reduceEvent(state, start("bash", args, "moved"), limits, 100_000);
		reduceEvent(state, end("bash", args, "moved", { job: "job-1", moved: true }), limits, 150_000);
		expect(state.declaredUntil).toBe(0);
		expect(state.jobsUntil).toBe(160_000);
		expect(heartbeatDue(state, 159_000, false)).toBe(true);
		reduceEvent(
			state,
			{
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Waiting on the job." }] },
			},
			limits,
			151_000,
		);
		expect(state.busyUntil).toBeGreaterThanOrEqual(161_000);
		expect(heartbeatDue(state, 160_000, false)).toBe(false);
		reduceEvent(state, notice(JOB_TYPE, { id: "job-1" }), limits, 160_000);
		expect(state.jobsUntil).toBe(0);
		expect(state.toolDeadlines.size).toBe(0);
	});

	it("does not borrow another concurrent call's deadline for a background handoff", () => {
		const state = newChildState();
		const short = { command: "sleep 60", timeout: 60 };
		const long = { command: "sleep 600", timeout: 600 };
		reduceEvent(state, start("bash", short, "short"), limits, 100_000);
		reduceEvent(state, start("bash", long, "long"), limits, 101_000);
		reduceEvent(state, end("bash", short, "short", { job: "job-1", moved: true }), limits, 150_000);
		expect(state.jobsUntil).toBe(160_000);
		reduceEvent(state, end("bash", long, "long", {}, true), limits, 151_000);
		expect(state.jobsUntil).toBe(160_000);
		expect(state.toolDeadlines.size).toBe(0);
	});

	it.each([false, true])("does not retain a declared wait after a foreground result (failed: %s)", (failed) => {
		const state = newChildState();
		state.running = true;
		const args = { command: "sleep 60", timeout: 60 };
		reduceEvent(state, start("bash", args, "foreground"), limits, 100_000);
		const details = failed ? { job: "failed-job", moved: true } : { exitCode: 0 };
		reduceEvent(state, end("bash", args, "foreground", details, failed), limits, 150_000);
		expect(state.waits).toBe(0);
		expect(state.jobsUntil).toBe(0);
		expect(heartbeatDue(state, 151_000, false)).toBe(false);
		expect(state.toolDeadlines.size).toBe(0);
	});

	it.each(["turn_start", "message_update"])("clears missing call-end deadlines on %s recovery", (type) => {
		const state = newChildState();
		reduceEvent(state, start("bash", { timeout: 60 }, "lost-result"), limits, 100_000);
		expect(state.toolDeadlines.size).toBe(1);
		reduceEvent(state, { type }, limits, 150_000);
		expect(state.toolsRunning).toBe(0);
		expect(state.toolDeadlines.size).toBe(0);
	});

	it("retains a repeating timer through active wakes and settles it once at its terminal wake", () => {
		const { state, apply, timer } = setup();
		timer(1);
		timer(2);
		apply(notice(TIMER_TYPE, { id: 1, kind: "every", status: "active", runs: 1, maxRuns: 20 }));
		expect(state.waits).toBe(2);
		apply(notice(TIMER_TYPE, { id: 1, kind: "every", status: "done", runs: 20, maxRuns: 20 }));
		expect(state.waits).toBe(1);
		apply(notice(TIMER_TYPE, { id: 1, kind: "every", status: "done" }));
		expect(state.waits).toBe(1);
	});

	it.each([JOB_TYPE, TIMER_TYPE])(
		"does not let an unrelated %s consume a reply wait or declared job deadline",
		(type) => {
			const { state, apply, message } = setup();
			message();
			const args = { background: true, timeout: 60 };
			apply(start("bash", args, "bash-1"));
			apply(end("bash", args, "bash-1", { job: "job-1", log: "/tmp/first.log" }));
			apply(notice(type, { id: 999, status: "finished" }));
			expect(state.waits).toBe(2);
			expect(state.jobsUntil).toBe(160_000);
			const answer = apply({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Waiting for peer." }] },
			}).find((effect) => effect.kind === "answer");
			expect(answer).toMatchObject({ waiting: true });
		},
	);

	it("settles only the matching job, tolerates duplicate completion, and leaves the reply pending", () => {
		const { state, apply, message } = setup();
		message();
		for (const id of ["job-1", "job-2"]) {
			apply(start("bash", { background: true }, id));
			apply(end("bash", { background: true }, id, { job: id, log: `/tmp/${id}.log` }));
		}
		apply(notice(JOB_TYPE, { id: "job-1", log: "/tmp/old-instance.log" }));
		expect(state.waits).toBe(3);
		apply(notice(JOB_TYPE, { id: "job-1", log: "/tmp/job-1.log" }));
		apply(notice(JOB_TYPE, { id: "job-1", log: "/tmp/job-1.log" }));
		expect(state.waits).toBe(2);
		apply(notice(INTERNAL_MESSAGE_TYPE, { messages: [{ from: "peer", replyTo: 42 }] }));
		expect(state.waits).toBe(1);
	});

	it("settles a successful cancellation, preserves a failed one, and cancels only timers with all", () => {
		const { state, apply, timer, message } = setup();
		message();
		timer(1);
		timer(2);
		const cancel = { op: "cancel", id: 1 };
		apply(start("timer", cancel, "cancel-failed"));
		apply(end("timer", cancel, "cancel-failed", {}, true));
		expect(state.waits).toBe(3);
		apply(start("timer", cancel, "cancel-1"));
		apply(end("timer", cancel, "cancel-1", { timer: { id: 1, status: "cancelled" } }));
		expect(state.waits).toBe(2);
		apply(start("timer", { op: "cancel", all: true }, "cancel-all"));
		apply(end("timer", { op: "cancel", all: true }, "cancel-all", { shown: 1 }));
		expect(state.waits).toBe(1);
		expect(state.replies).toHaveLength(1);
		expect(state.waitInputs.size).toBe(0);
	});

	it.each(["timer", "agent"])("drops a failed %s wait with the real argument-free RPC result", (tool) => {
		const { state, apply } = setup();
		const args = tool === "timer" ? timerArgs : messageArgs;
		apply(start(tool, args, "failed"));
		expect(state.waits).toBe(1);
		apply(end(tool, args, "failed", {}, true));
		expect(state.waits).toBe(0);
		expect(state.waitInputs.size).toBe(0);
	});

	it("an unpaired failure or unknown notice cannot settle another call", () => {
		const { state, apply, timer } = setup();
		timer(1);
		apply(end("timer", timerArgs, "never-started", {}, true));
		apply(notice(TIMER_TYPE, { status: "finished" }));
		apply(notice(JOB_TYPE, {}));
		expect(state.waits).toBe(1);
	});

	it("keeps a report intact through repeating wakes, cancellation and late duplicate wakes while a reply is pending", () => {
		const { state, timer, message } = setup();
		const report = new ReportTracker();
		const apply = (event: Record<string, unknown>) => {
			for (const effect of reduceEvent(state, event, limits, 100_000))
				if (effect.kind === "answer")
					report.answer(effect.text, effect.stopReason, effect.errorMessage, effect.waiting, effect.reminder);
				else if (effect.kind === "incoming") report.incoming(effect.role, effect.job, effect.quiet);
		};
		const answer = (text: string) => ({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
		});
		apply(answer("Done: the review is complete."));
		message();
		timer(1);
		apply(notice(TIMER_TYPE, { id: 1, kind: "every", status: "active", runs: 1 }));
		expect(state.waits).toBe(2);
		apply(answer("The timer reminded me; nothing to add."));
		apply(start("timer", { op: "cancel", id: 1 }, "cancel-1"));
		apply(end("timer", { op: "cancel", id: 1 }, "cancel-1", { timer: { id: 1, status: "cancelled" } }));
		apply(notice(TIMER_TYPE, { id: 1, kind: "every", status: "active", runs: 1 }));
		apply(notice(TIMER_TYPE, { id: 1, kind: "every", status: "cancelled" }));
		expect(state.waits).toBe(1);
		apply(notice(INTERNAL_MESSAGE_TYPE, { messages: [{ from: "unrelated", replyTo: 99 }] }));
		apply(answer("Waiting for peer."));
		expect(report.result().text).toBe("Done: the review is complete.");
		apply(notice(INTERNAL_MESSAGE_TYPE, { messages: [{ from: "peer", replyTo: 42 }] }));
		expect(state.waits).toBe(0);
		apply(answer("Done: the peer confirmed the fix."));
		expect(report.result().text).toContain("Done: the peer confirmed the fix.");
	});
});
