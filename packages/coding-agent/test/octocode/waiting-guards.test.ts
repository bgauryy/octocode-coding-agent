import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, timers } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { INTERNAL_MESSAGE_TYPE, JOB_TYPE, TIMER_TYPE } from "../../src/octocode/shared/messages.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import { isWaitingLine } from "../../src/octocode/subagents/pending-waits.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { CheckIn, checkInConfig } from "../../src/octocode/monitor/attention/check-in.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { ConditionDeps } from "../../src/octocode/timer/conditions/types.ts";
import { timerTool } from "../../src/octocode/native/tools/notify/tool.ts";
import { tmp } from "./helpers.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const MIN = 60_000;

describe("the check-in while the child waits on its own work", () => {
	const member = (id: string, parentId?: string): Member => ({
		id,
		role: id.split("-")[0],
		...(parentId ? { parentId } : {}),
		pid: process.pid,
		status: "working",
		joinedAt: 1_000,
		updatedAt: Date.now(),
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
	});
	let store: TeamStore | undefined;
	afterEach(() => store?.close());

	it.each(["bash", "timer"] as const)("stays quiet with a %s row, and pings once it is gone", (kind) => {
		store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		for (const row of [member("p-1"), member("c-1", "p-1")]) store.save(row);
		const owner = {};
		const work = runningWorkOf(owner);
		const notice = vi.fn((_text: string) => true);
		const ping = new CheckIn({ notice, lastExchange: (me, parent) => store!.refs.lastExchange(me, parent) });
		const start = Date.now();
		ping.begin(start);
		work.set(kind, [{ kind, id: "x", title: "waiting" }]);
		const busy = checkInConfig({ monitor: { checkInSeconds: 300 } }, false, owner);
		ping.due("c-1", "p-1", busy, start + 6 * MIN);
		expect(notice).not.toHaveBeenCalled();
		work.set(kind, []);
		ping.due("c-1", "p-1", checkInConfig({ monitor: { checkInSeconds: 300 } }, false, owner), start + 6 * MIN);
		expect(notice).toHaveBeenCalledTimes(1);
	});

	it("does not count other running work (an external prompt)", () => {
		const owner = {};
		const work = runningWorkOf(owner);
		work.set("external", [{ kind: "external", id: "e", title: "prompt" }]);
		expect(checkInConfig({ monitor: { checkInSeconds: 300 } }, false, owner).busy).toBe(false);
	});
});

describe("an until timer on an agent that already ended", () => {
	const setup = (agentEnd: ConditionDeps["agentEnd"], item?: ConditionDeps["item"]) => {
		const root = tmp();
		const agent = openDatabase({
			file: path.join(root, "workspaces.db"),
			mirrorFile: path.join(root, "transcripts.db"),
			archiveDir: path.join(root, "archive"),
			privateParent: false,
		});
		const workspace = registeredWorkspace(root, agent).id;
		const tool = timerTool({
			db: () => agent,
			workspaceId: () => workspace,
			agent: () => "me",
			now: () => Date.UTC(2026, 10, 6, 12),
			deps: { agentEnd, item } as ConditionDeps,
			implicit: () => "",
			checkRefusal: async () => undefined,
			cronRefusal: async () => undefined,
			cronCap: () => 2,
			sessionUsd: () => 0,
			changed: () => undefined,
		});
		const ctx = { cwd: root, sessionManager: { getSessionId: () => "s1" } } as never;
		const setUntil = (args: object) =>
			tool.execute("c", { op: "on", note: "n", ...args } as never, undefined, undefined, ctx);
		const set = (name: string) => setUntil({ event: "agent.ended", filter: { agent: name } });
		return { agent, set, setUntil, root };
	};

	it("is refused with a message and sets nothing", async () => {
		const { agent, set, root } = setup((name) => (name === "done-1" ? { reason: "completed" } : undefined));
		try {
			await expect(set("done-1")).rejects.toThrow(/done-1 already ended \(completed\).*Nothing was set/);
			expect(timers.activeCount(agent.db, "s1")).toBe(0);
			await set("live-1");
			expect(timers.activeCount(agent.db, "s1")).toBe(1);
		} finally {
			agent.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses an until item naming an unknown item when set, not at the first check", async () => {
		const { agent, setUntil, root } = setup(
			() => undefined,
			(ref) => (ref === "B1" ? "ongoing" : undefined),
		);
		try {
			await expect(setUntil({ event: "item.state", filter: { ref: "B1, B99999", state: "done" } })).rejects.toThrow(
				/No backlog item B99999 in this workspace\. Nothing was set/,
			);
			expect(timers.activeCount(agent.db, "s1")).toBe(0);
			await setUntil({ event: "item.state", filter: { ref: "B1", state: "done" } });
			expect(timers.activeCount(agent.db, "s1")).toBe(1);
		} finally {
			agent.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("a waiting-only final text of a child with pending work", () => {
	const LIMITS = { idleMs: 1_000, busyMs: 5_000 };
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
	const reply = (text: string) => ({
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage },
	});
	const start = (toolName: string, args: Record<string, unknown>) => ({ type: "tool_execution_start", toolName, args });

	function run(events: Array<Record<string, unknown>>) {
		const state = newChildState();
		const report = new ReportTracker();
		for (const event of events)
			for (const effect of reduceEvent(state, event, LIMITS, 1_000))
				if (effect.kind === "answer")
					report.answer(effect.text, effect.stopReason, effect.errorMessage, effect.waiting, effect.reminder);
				else if (effect.kind === "incoming") report.incoming(effect.role, effect.job, effect.quiet);
		return { state, report };
	}
	const userTurn = { type: "message_end", message: { role: "user", content: "go" } };

	it("does not pad the report while a background job is pending, and the real report stays intact", () => {
		const { report } = run([
			userTurn,
			reply("Done: the audit is in."),
			start("bash", { background: true, command: "sleep 9" }),
			userTurn,
			reply("Waiting on the background job."),
			userTurn,
			reply("Still waiting."),
		]);
		expect(report.result().text).toBe("Done: the audit is in.");
	});

	it("does not pad the report while a timer is pending", () => {
		const { report, state } = run([
			userTurn,
			reply("Done: findings below."),
			start("notify", { op: "set", after: 60 }),
			userTurn,
			reply("waiting for the timer"),
		]);
		expect(state.waits).toBe(1);
		expect(report.result().text).toBe("Done: findings below.");
	});

	it("keeps a waiting line once nothing is pending, and any text with more than the waiting line", () => {
		const ended = run([
			userTurn,
			reply("Done: one."),
			start("bash", { background: true }),
			{
				type: "tool_execution_end",
				toolName: "bash",
				args: { background: true },
				result: { details: { job: "job-1" } },
			},
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: JOB_TYPE,
					details: { id: "job-1" },
					content: "Background bash job ended",
				},
			},
			reply("Waiting on nothing now."),
		]);
		expect(ended.state.waits).toBe(0);
		expect(ended.report.result().text).toContain("Waiting on nothing now.");

		const more = run([
			userTurn,
			reply("Done: one."),
			start("notify", { op: "set", after: 5 }),
			userTurn,
			reply("Waiting on the timer.\nFound a defect in x.ts, fix below."),
		]);
		expect(more.report.result().text).toContain("Found a defect in x.ts");
	});

	it("counts a wake message as the end of one wait and a failed call as none", () => {
		const { state } = run([
			start("notify", { op: "set", after: 5 }),
			{ type: "tool_execution_end", toolName: "notify", args: { op: "set" }, isError: true },
			start("notify", { op: "set", after: 5 }),
			{
				type: "tool_execution_end",
				toolName: "notify",
				args: { op: "set" },
				result: { details: { timer: { id: 1 } } },
			},
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: TIMER_TYPE,
					details: { id: 1, status: "done" },
					content: "Timer 1 woke",
				},
			},
		]);
		expect(state.waits).toBe(0);
	});

	it("keeps a first answer that is only a waiting line, since the report would be empty", () => {
		const { report } = run([userTurn, start("bash", { background: true }), reply("Waiting for the job.")]);
		expect(report.result().text).toBe("Waiting for the job.");
	});
	it("does not pad the report while the child waits for a teammate's or the parent's reply", () => {
		const { report, state } = run([
			userTurn,
			reply("Done: the review is below."),
			start("agent", { type: "message", to: "parent", replyRequired: true, message: "which schema?" }),
			userTurn,
			reply("Waiting for the parent's reply."),
			userTurn,
			reply("Still waiting on the reply\nStatus: no answer yet"),
		]);
		expect(state.waits).toBe(1);
		expect(report.result().text).toBe("Done: the review is below.");
	});

	it("ends a requested reply only on its own answer; an FYI message starts no wait", () => {
		const fyi = run([start("agent", { type: "message", to: "all", message: "fyi" })]);
		expect(fyi.state.waits).toBe(0);
		const mail = (...messages: Array<Record<string, unknown>>) => ({
			type: "message_end",
			message: { role: "custom", customType: INTERNAL_MESSAGE_TYPE, content: "mail", details: { messages } },
		});
		const sent = [
			{
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "agent",
				args: { type: "message", to: "parent", replyRequired: true },
			},
			{
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "agent",
				args: { type: "message", to: "parent", replyRequired: true },
				result: { details: { id: 7, to: ["wily-ink"] } },
			},
		];
		// An unrelated message (another sender, no reply to #7) leaves the wait; a reply to #7 or the asked agent ends it.
		const unrelated = run([...sent, mail({ id: 9, from: "peer-1", to: "me", text: "hi" })]);
		expect(unrelated.state.waits).toBe(1);
		expect(run([...sent, mail({ id: 9, from: "peer-1", to: "me", text: "hi", replyTo: 7 })]).state.waits).toBe(0);
		expect(run([...sent, mail({ id: 9, from: "wily-ink", to: "me", text: "hi" })]).state.waits).toBe(0);
		// A failed send started nothing.
		const failed = run([sent[0], { ...sent[1], isError: true }]);
		expect(failed.state.waits).toBe(0);
		expect(failed.state.replies).toEqual([]);
	});

	it("drops the echo of its own timer's wake after the report, but keeps work done after the wake", () => {
		const timer = {
			type: "message_end",
			message: { role: "custom", customType: TIMER_TYPE, content: "Timer 1 fired" },
		};
		const echoed = run([
			userTurn,
			reply("Done: the audit is in."),
			timer,
			reply("Timer 1 only reminded me; nothing to add."),
		]);
		expect(echoed.report.result().text).toBe("Done: the audit is in.");
		const worked = run([
			userTurn,
			reply("Done: the audit is in."),
			timer,
			start("bash", { command: "ls" }),
			reply("Done: the rerun found one more issue."),
		]);
		expect(worked.report.result().text).toContain("the rerun found one more issue");
		// A message from the parent after the timer is a new task, not the echo.
		const asked = run([userTurn, reply("Done: first."), timer, userTurn, reply("Done: second.")]);
		expect(asked.report.result().text).toContain("Done: second.");
	});

	it("does not pad the report for an unrelated message while a requested reply is pending", () => {
		const { report } = run([
			userTurn,
			reply("Done: the review is below."),
			{
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "agent",
				args: { type: "message", to: "parent", replyRequired: true },
			},
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: INTERNAL_MESSAGE_TYPE,
					content: "x",
					details: { messages: [{ id: 3, from: "peer-1", to: "me", text: "fyi" }] },
				},
			},
			userTurn,
			reply("Waiting for the parent's reply."),
		]);
		expect(report.result().text).toBe("Done: the review is below.");
	});

	it("drops a multi-line waiting text, and keeps any text with a line of content", () => {
		const { report } = run([
			userTurn,
			reply("Done: all green."),
			start("notify", { op: "set", after: 60 }),
			userTurn,
			reply("Waiting for the timer.\n- Still waiting on the build job\nStatus: idle until it fires"),
			userTurn,
			reply("Waiting for the timer.\nThe build log shows a failure in a.ts."),
		]);
		const text = report.result().text;
		expect(text).toContain("Done: all green.");
		expect(text).not.toContain("Status: idle");
		expect(text).toContain("The build log shows a failure in a.ts.");
	});

	it("replaces a first answer that is only a waiting line once a later section exists", () => {
		const { report } = run([
			userTurn,
			start("bash", { background: true }),
			reply("Waiting for the job."),
			userTurn,
			reply("Done: the job found two defects."),
		]);
		expect(report.result().text).toBe("Done: the job found two defects.");
		expect(report.result().answered).toBe(true);
	});

	it("keeps a final waiting-only report when no real report ever follows", () => {
		const { report } = run([userTurn, reply("Waiting for the job."), userTurn, reply("Waiting for the job.")]);
		expect(report.result().text).toBe("Waiting for the job.");
	});

	it("tells a waiting-only text from one with content", () => {
		expect(isWaitingLine("Waiting for peer wily-ink.")).toBe(true);
		expect(isWaitingLine("**Waiting** on the reply\n\nStatus: blocked")).toBe(true);
		expect(isWaitingLine("Waiting on the build.\nResult: 3 tests failed.")).toBe(false);
		expect(isWaitingLine("Status: waiting")).toBe(false);
		expect(isWaitingLine(`Waiting ${"x".repeat(700)}`)).toBe(false);
	});
});
