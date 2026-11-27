import { expect, it } from "vitest";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { admitResultSchema } from "../../src/octocode/subagents/result-schema.ts";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";
import { TIMER_TYPE } from "../../src/octocode/shared/messages.ts";

const contract = admitResultSchema({
	type: "object",
	properties: { verdict: { type: "string" } },
	required: ["verdict"],
	additionalProperties: false,
});
const answer = (verdict = "pass") => `done\nStructured result:\n\`\`\`json\n${JSON.stringify({ verdict })}\n\`\`\``;

/** Feed actual child event effects to the same report methods as the process supervisor. */
function lifecycle() {
	const tracker = new ReportTracker(undefined, contract);
	const state = newChildState();
	const emit = (event: Record<string, unknown>) => {
		for (const effect of reduceEvent(state, event, { idleMs: 1000, busyMs: 1000 }, 1)) {
			if (effect.kind === "incoming") tracker.incoming(effect.role, effect.job, effect.quiet, effect.reminder);
			if (effect.kind === "answer")
				tracker.answer(effect.text, effect.stopReason, effect.errorMessage, effect.waiting, effect.reminder);
		}
	};
	const reply = (text: string | undefined, stopReason = "stop") =>
		emit({
			type: "message_end",
			message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, usage: emptyUsage() },
		});
	const incoming = (role = "custom", customType = role === "custom" ? TIMER_TYPE : undefined) =>
		emit({ type: "message_end", message: { role, customType, content: "Reminder" } });
	reply(answer());
	return { tracker, emit, reply, incoming };
}

it("keeps the accepted structured report when a later final only waits", () => {
	const { tracker } = lifecycle();
	const before = tracker.result();
	tracker.answer("Waiting for the build.", "stop", undefined, true, false);
	expect(tracker.result().text).toBe(before.text);
	expect(tracker.result().structured).toEqual(before.structured);
});

it("keeps the accepted report through timer incoming and an ignored reminder final", () => {
	const { tracker, incoming, reply } = lifecycle();
	const before = tracker.result();
	incoming();
	reply("Still watching the build.");
	expect(tracker.result().text).toBe(before.text);
	expect(tracker.result().structured).toEqual(before.structured);
});

it("invalidates on real tool work after a timer and accepts the replacement report", () => {
	const { tracker, incoming, reply, emit } = lifecycle();
	incoming();
	reply("Checking the new evidence.", "toolUse");
	emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "check", args: { command: "true" } });
	expect(tracker.result().structured?.status).toBe("unavailable");
	reply(answer("changed"));
	expect(tracker.result().structured).toMatchObject({ status: "valid", data: { verdict: "changed" } });
});

it("does not restore a predecessor's data when a new user task initially waits", () => {
	const { tracker, incoming, reply } = lifecycle();
	incoming("user");
	tracker.answer("Waiting for the build.", "stop", undefined, true, false);
	expect(tracker.result().structured?.status).toBe("unavailable");
	reply(answer("new task"));
	expect(tracker.result().structured).toMatchObject({ status: "valid", data: { verdict: "new task" } });
});

it("invalidates the prior result if the timer turn fails", () => {
	const { tracker, incoming, reply } = lifecycle();
	incoming();
	reply(undefined, "error");
	expect(tracker.result().structured?.status).toBe("unavailable");
});
