import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { liveItemJobs } from "../../src/octocode/shared/job-records.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { registerIdleItems } from "../../src/octocode/subagents/idle-items.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import type { Team } from "../../src/octocode/team/session.ts";
import { turnLineText } from "../../src/octocode/ui/turn-line.ts";
import type { AgentEvent } from "../../src/octocode/wake/catalog.ts";
import { WAKE_TYPE, wakeGateOf } from "../../src/octocode/wake/gate.ts";
import { registerWake, writtenRefs } from "../../src/octocode/wake/register.ts";
import { eventWindowMs } from "../../src/octocode/wake/session-signals.ts";
import { MemoryEventStore } from "../../src/octocode/events/loop/store.ts";
import { collapsedWakeRow, wakeLines } from "../../src/octocode/ui/wake-row.ts";
import { sendAgentReport } from "../../src/octocode/subagents/handoff/wake.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const READY = { goal: "Expected result", why: "Required work" };

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-wake-gate-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

const shutdown: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of shutdown.splice(0)) await close();
	vi.useRealTimers();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const reportOn = (item: string | undefined, agent = "jolly-reef"): AgentEvent => ({
	kind: "agent.report",
	agent,
	role: "implementer",
	outcome: "done",
	...(item ? { item } : {}),
	reportId: `r-${agent}`,
});

/** Without settings the gate is unheld: most cases are about rows and nudges, and those that hold set their window. */
function setup(settings: Record<string, unknown> = { subagents: { wakeHoldSeconds: 0 } }) {
	const fake = fakeHost(settings);
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const store = new MemoryEventStore();
	registerWake(fake.api, { live: { store: () => store } });
	const runs = { running: new Map<string, undefined>(), items: new Map<string, string>() };
	registerIdleItems(fake.api, { reserved: () => false } as unknown as Team, runs, { onItem: () => undefined });
	const backlog = openBacklog(ctx, { isSubagent: false });
	const hold = (title: string) => {
		const item = backlog.store.add({ ...READY, title, state: "todo", createdBy: "user" });
		return backlog.store.update(item.ref, { state: "ongoing" }, backlog.actor).ref;
	};
	const run = async (during?: () => Promise<void> | void) => {
		await fake.emit("agent_start", {}, ctx);
		await during?.();
		await fake.emit("agent_settled", { aborted: false }, ctx);
	};
	const ids = (items: string[]) => items.map((ref) => ref);
	return { fake, ctx, runs, hold, run, store, gate: wakeGateOf(fake.api), ids };
}

/** Starts the real loop when a case needs session scheduling; gate-only cases exercise its unbound fallback. */
async function active(settings: Record<string, unknown>) {
	const s = setup(settings);
	await s.fake.emit("session_start", { reason: "startup" }, s.ctx);
	shutdown.push(() => s.fake.emit("session_shutdown", { reason: "quit" }, s.ctx));
	return s;
}

const nudges = (fake: ReturnType<typeof fakeHost>) =>
	fake.sent.filter((entry) => entry.message.customType === "octocode-idle-item");

/** The text of a sent message under its source header (the header is pinned in events/source.test.ts). */
const unsourced = (content: unknown) => String(content).replace(/^\[src [^\n]*\n/, "");

describe("idle-item nudge gate (rule D2)", () => {
	it("still names an item the ended run was only woken about, and does not count a drop", async () => {
		const s = setup();
		const woken = s.hold("woken");
		s.runs.running.set("child", undefined);
		s.gate.emit(
			reportOn(woken),
			{ customType: "octocode-agent-result", content: "r", display: true },
			{ triggerTurn: true },
		);
		await s.run();
		const named = nudges(s.fake);
		expect(named).toHaveLength(1);
		expect(named[0].message.content).toContain(woken);
		expect(s.gate.droppedCount()).toBe(0);
	});

	it("counts a delegation to the item as writing it", async () => {
		const s = setup();
		const ref = s.hold("delegated");
		s.runs.running.set("child", undefined);
		await s.run(async () => {
			await s.fake.emit(
				"tool_execution_start",
				{ toolCallId: "c1", toolName: "agent", args: { item: ref, task: "x" } },
				s.ctx,
			);
			await s.fake.emit("tool_execution_end", { toolCallId: "c1", toolName: "agent", isError: false }, s.ctx);
		});
		expect(nudges(s.fake)).toHaveLength(0);
		expect(s.gate.droppedCount()).toBe(1);
	});

	it("does not mark a dropped item told: a later run that left it alone gets the nudge", async () => {
		const s = setup();
		const ref = s.hold("orphan after a note");
		s.runs.running.set("child", undefined);
		const note = async () => {
			await s.fake.emit(
				"tool_execution_start",
				{ toolCallId: "c1", toolName: "backlog", args: { op: "note", id: ref } },
				s.ctx,
			);
			await s.fake.emit("tool_execution_end", { toolCallId: "c1", toolName: "backlog", isError: false }, s.ctx);
		};
		await s.run(note);
		expect(nudges(s.fake)).toHaveLength(0);
		expect(s.gate.droppedCount()).toBe(1);
		s.gate.ackDropped(1);
		// The next run wrote nothing about it while the child keeps running: now it is named, once.
		await s.run();
		expect(nudges(s.fake)).toHaveLength(1);
		expect(nudges(s.fake)[0].message.content).toContain(ref);
		expect(s.gate.droppedCount()).toBe(0);
		await s.run();
		expect(nudges(s.fake)).toHaveLength(1);
	});

	it("drops the nudge for an item a tool call of the run wrote", async () => {
		const s = setup();
		const written = s.hold("written");
		s.runs.running.set("child", undefined);
		await s.run(async () => {
			await s.fake.emit(
				"tool_execution_start",
				{ toolCallId: "c1", toolName: "backlog", args: { op: "note", id: written } },
				s.ctx,
			);
			await s.fake.emit("tool_execution_end", { toolCallId: "c1", toolName: "backlog", isError: false }, s.ctx);
		});
		expect(nudges(s.fake)).toHaveLength(0);
		expect(s.gate.droppedCount()).toBe(1);
	});

	it("does not count a failed write, a read, or a write to another item", async () => {
		const s = setup();
		const ref = s.hold("untouched");
		s.runs.running.set("child", undefined);
		await s.run(async () => {
			await s.fake.emit(
				"tool_execution_start",
				{ toolCallId: "c1", toolName: "backlog", args: { op: "note", id: ref } },
				s.ctx,
			);
			await s.fake.emit("tool_execution_end", { toolCallId: "c1", toolName: "backlog", isError: true }, s.ctx);
			await s.fake.emit(
				"tool_execution_start",
				{ toolCallId: "c2", toolName: "backlog", args: { op: "get", id: ref } },
				s.ctx,
			);
			await s.fake.emit("tool_execution_end", { toolCallId: "c2", toolName: "backlog", isError: false }, s.ctx);
		});
		expect(nudges(s.fake)).toHaveLength(1);
		expect(s.gate.droppedCount()).toBe(0);
	});

	it("forgets what the last run did when a new run starts", async () => {
		const s = setup();
		const ref = s.hold("again");
		s.runs.running.set("child", undefined);
		await s.run(async () => {
			await s.fake.emit(
				"tool_execution_start",
				{ toolCallId: "c1", toolName: "backlog", args: { op: "claim", id: ref } },
				s.ctx,
			);
			await s.fake.emit("tool_execution_end", { toolCallId: "c1", toolName: "backlog", isError: false }, s.ctx);
		});
		expect(nudges(s.fake)).toHaveLength(0);
		// A user prompt starts the next run, which wrote nothing: the item is named while the child still runs.
		await s.run();
		expect(nudges(s.fake)).toHaveLength(1);
	});

	it("says nothing for an item a running background bash job names", async () => {
		const s = setup();
		const ref = s.hold("served by a job");
		const other = s.hold("free");
		runningWorkOf(s.fake.api).set("bash", [{ kind: "bash", id: "bash-1", title: "make", item: ref.toLowerCase() }]);
		await s.run();
		expect(nudges(s.fake).map((entry) => entry.message.content)).toEqual([expect.stringContaining(other)]);
		// Not counted as dropped: it was never idle.
		expect(s.gate.droppedCount()).toBe(0);
	});

	it("reads item refs the way the backlog spells them", () => {
		expect(writtenRefs("backlog", { op: "done", id: "b12" })).toEqual(["b12"]);
		expect(writtenRefs("backlog", { op: "step", id: "T3" })).toEqual(["T3"]);
		expect(writtenRefs("backlog", { op: "get", id: "B1" })).toEqual([]);
		expect(writtenRefs("agent", { item: "B9", task: "x" })).toEqual(["B9"]);
		expect(writtenRefs("file", { id: "B9" })).toEqual([]);
	});
});

describe("hold window", () => {
	const msg = (n: number) => ({ customType: "t", content: `m${n}`, display: true });

	it("holds an idle session's wakes for the default window, then starts one turn for them", async () => {
		vi.useFakeTimers();
		const s = await active({});
		const windowMs = SETTINGS_DEFAULTS.subagents.wakeHoldSeconds * 1000;
		expect(windowMs).toBeGreaterThan(0);
		const first = s.gate.emit(reportOn(undefined, "a"), msg(1), { triggerTurn: true, deliverAs: "followUp" });
		s.gate.emit(reportOn(undefined, "b"), msg(2), { triggerTurn: true, deliverAs: "followUp" });
		vi.advanceTimersByTime(windowMs - 1);
		expect(s.fake.sent).toHaveLength(0);
		vi.advanceTimersByTime(1);
		await first;
		expect(s.fake.sent.map((entry) => entry.options.triggerTurn)).toEqual([false, true]);
	});

	it("is off at 0: each wake is sent at once", async () => {
		const s = await active({ subagents: { wakeHoldSeconds: 0 } });
		s.gate.emit(reportOn(undefined, "a"), msg(1), { triggerTurn: true });
		s.gate.emit(reportOn(undefined, "b"), msg(2), { triggerTurn: true });
		expect(s.fake.sent.map((entry) => entry.options.triggerTurn)).toEqual([true, true]);
	});

	it("merges wakes of an idle session that arrive inside the window into one turn", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 2 } });
		const first = s.gate.emit(reportOn(undefined, "a"), msg(1), { triggerTurn: true, deliverAs: "followUp" });
		vi.advanceTimersByTime(1000);
		s.gate.emit(reportOn(undefined, "b"), msg(2), { triggerTurn: true, deliverAs: "followUp" });
		expect(s.fake.sent).toHaveLength(0);
		vi.advanceTimersByTime(1000);
		await first;
		expect(
			s.fake.sent.map((entry) => [
				unsourced(entry.message.content),
				entry.options.triggerTurn,
				entry.options.deliverAs,
			]),
		).toEqual([
			["m1", false, "steer"],
			["m2", true, "steer"],
		]);
	});

	it("delivers the wake at the next tool boundary while a run is in progress", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 2 } });
		await s.fake.emit("agent_start", {}, s.ctx);
		await s.gate.emit(reportOn(undefined, "a"), msg(1), { triggerTurn: true, deliverAs: "followUp" });
		expect(s.fake.sent).toHaveLength(0);
		await s.fake.emit("turn_end", { toolResults: [{}] }, s.ctx);
		expect(s.fake.sent).toHaveLength(1);
	});

	it("sends what is held when the session ends", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 5 } });
		s.gate.emit(reportOn(undefined, "a"), msg(1), { triggerTurn: true });
		expect(s.fake.sent).toHaveLength(0);
		await s.fake.emit("session_shutdown", {}, s.ctx);
		expect(s.fake.sent).toHaveLength(1);
	});

	it("uses the runtime window before the legacy setting, bounds it, and disables invalid values", () => {
		const window = (value: unknown) =>
			eventWindowMs(fakeHost({ runtime: { eventWindowSeconds: value }, subagents: { wakeHoldSeconds: 4 } }).api);
		expect(window(3)).toBe(3000);
		expect(window(undefined)).toBe(4000);
		expect(window(99)).toBe(10_000);
		expect([0, -1, "2", Number.NaN].map(window)).toEqual([0, 0, 0, 0]);
	});
});

describe("woke row", () => {
	const msg = { customType: "octocode-hook-context", content: "hidden", display: false };

	it("draws one row for every wake of a batch before the run's first request, and none for a user prompt", async () => {
		const s = setup();
		await s.fake.emit("agent_start", {}, s.ctx);
		await s.fake.emit("agent_settled", { aborted: false }, s.ctx);
		expect(s.fake.entries).toHaveLength(0);
		sendAgentReport(
			s.fake.api,
			{
				content: "c",
				details: { id: "jolly-reef", status: "done", outcome: "done", summary: "" },
				wake: true,
				reportId: "r1",
			},
			{},
			"B526",
			false,
		);
		wakeGateOf(s.fake.api).emit({ kind: "job.exit", job: "bash-5", exit: 0, durationMs: 4000, startedAt: 1 }, msg, {
			triggerTurn: true,
		});
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(s.fake.entries).toHaveLength(1);
		const [entry] = s.fake.entries;
		expect(entry.customType).toBe(WAKE_TYPE);
		expect(wakeLines(entry.data)[0]).toMatchObject({
			kind: "agent.report",
			from: "child jolly-reef",
			data: { agent: "jolly-reef", outcome: "done", item: "B526" },
		});
		expect(wakeLines(entry.data).map((line) => line.label)).toEqual([
			"report jolly-reef done (B526)",
			"job bash-5 exit 0 \u00b7 4s",
		]);
		// The next segment of the same run has nothing new to say.
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(s.fake.entries).toHaveLength(1);
	});

	it("shows a hidden idle-item nudge", async () => {
		const s = setup();
		const ref = s.hold("orphan");
		s.runs.running.set("child", undefined);
		await s.run();
		await s.fake.emit("agent_start", {}, s.ctx);
		const [entry] = s.fake.entries;
		expect(wakeLines(entry.data)[0].label).toBe(`${ref} idle: you hold it, nothing works on it`);
	});

	it("draws nothing without a terminal, and never lists a message that starts no turn", async () => {
		const s = setup();
		wakeGateOf(s.fake.api).emit({ kind: "peer.notice", text: "quiet", seq: 1 }, msg, { triggerTurn: false });
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(s.fake.entries).toHaveLength(0);
		wakeGateOf(s.fake.api).emit({ kind: "peer.notice", text: "loud", seq: 2 }, msg, { triggerTurn: true });
		await s.fake.emit("agent_settled", { aborted: false }, s.ctx);
		await s.fake.emit("agent_start", {}, { ...s.ctx, hasUI: false });
		expect(s.fake.entries).toHaveLength(0);
	});

	it("clips the collapsed row to the width with a count of the rest", () => {
		const lines = ["report a done", "job bash-1 exit 0", "job bash-2 exit 1"].map((label) => ({ kind: "x", label }));
		expect(collapsedWakeRow(lines, 200)).toBe(
			"\u26a1 woke \u00b7 report a done \u00b7 job bash-1 exit 0 \u00b7 job bash-2 exit 1",
		);
		const narrow = collapsedWakeRow(lines, 45);
		expect(narrow).toBe("\u26a1 woke \u00b7 report a done \u00b7 +2 more");
		expect(narrow.length).toBeLessThanOrEqual(45);
	});
});

describe("dropped nudges on the turn record", () => {
	it("says how many a run's wake gate dropped", () => {
		expect(turnLineText({ ms: 4000, tools: 1, dropped: 2 })).toContain("2 nudges dropped");
		expect(turnLineText({ ms: 4000, tools: 1, dropped: 1 })).toContain("1 nudge dropped");
		expect(turnLineText({ ms: 4000, tools: 1 })).not.toContain("dropped");
	});
});

describe("bash item link", () => {
	it("records the item on the job and its owner record, shown by coordinate list as work on that item", async () => {
		const dir = path.join(tmp, "jobs");
		const jobs = new BashJobs(dir);
		const job = await jobs.start("sleep 30", tmp, undefined, () => undefined, { item: "B7", reason: "long check" });
		try {
			expect(job.item).toBe("B7");
			expect(liveItemJobs(dir)).toEqual([{ id: job.id, item: "B7" }]);
			const member = { id: "main", role: "main", status: "idle", pid: 1, joinedAt: 0, updatedAt: 0 } as never;
			const text = describeMembers(
				[member],
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				[],
				new Map([["main", { jobs: liveItemJobs(dir) }]]),
			);
			expect(text).toContain(`work: ${job.id} on B7`);
		} finally {
			await jobs.stopAll("session end");
		}
		expect(liveItemJobs(dir)).toEqual([]);
	});

	it("leaves a job without an item out of the list", async () => {
		const dir = path.join(tmp, "jobs");
		const jobs = new BashJobs(dir);
		await jobs.start("sleep 30", tmp, undefined, () => undefined, {});
		try {
			expect(liveItemJobs(dir)).toEqual([]);
		} finally {
			await jobs.stopAll("session end");
		}
	});
});

describe("session end with held wakes", () => {
	const msg = (n: number) => ({ customType: "t", content: `m${n}`, display: true });

	it("sends held messages without starting a turn in the session being torn down", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 5 } });
		s.gate.emit(reportOn(undefined, "a"), msg(1), { triggerTurn: true, deliverAs: "followUp" });
		s.gate.emit(reportOn(undefined, "b"), msg(2), { triggerTurn: true, deliverAs: "followUp" });
		await s.fake.emit("session_shutdown", {}, s.ctx);
		expect(s.fake.sent.map((entry) => [unsourced(entry.message.content), entry.options.triggerTurn])).toEqual([
			["m1", false],
			["m2", false],
		]);
		// The timer is gone: nothing is sent twice later.
		vi.advanceTimersByTime(10_000);
		expect(s.fake.sent).toHaveLength(2);
	});

	it("preserves accepted events for replay when shutdown cannot deliver them, and reports it once", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 5 } });
		const written: string[] = [];
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		try {
			(s.fake.api.session as unknown as { sendMessage: () => never }).sendMessage = () => {
				throw new Error("session is closed");
			};
			const first = s.gate.emit(reportOn(undefined, "a"), msg(1), { triggerTurn: true }) as Promise<void>;
			const second = s.gate.emit(reportOn(undefined, "b"), msg(2), { triggerTurn: true }) as Promise<void>;
			await Promise.all([first, second]);
			await s.fake.emit("session_shutdown", {}, s.ctx);
			expect(s.store.unread().map((event) => event.topic)).toEqual(["agent.report", "agent.report"]);
			expect(written).toHaveLength(1);
			expect(written[0]).toContain("session is closed");
		} finally {
			stderr.mockRestore();
		}
	});
});

describe("a hold does not delay what a busy run takes", () => {
	it("delivers an interrupt once the aborted run has settled", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 5 } });
		await s.fake.emit("agent_start", {}, s.ctx);
		s.gate.emit(
			{ kind: "agent.message", from: "boss", id: 1, replyRequired: true, interrupt: true },
			{ customType: "t", content: "stop", display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		expect(s.fake.sent).toHaveLength(0);
		await s.fake.emit("agent_settled", { aborted: true }, s.ctx);
		expect(s.fake.sent).toHaveLength(1);
		expect(s.fake.sent[0].options.triggerTurn).toBe(true);
	});

	it("holds again only once the run has settled", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 5 } });
		await s.run();
		s.gate.emit(
			{ kind: "agent.message", from: "boss", id: 2, replyRequired: false, interrupt: false },
			{ customType: "t", content: "later", display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		expect(s.fake.sent).toHaveLength(0);
	});
});

describe("woke row lines", () => {
	const msg = { customType: "octocode-hook-context", content: "hidden", display: false };
	const mail = (id: number): AgentEvent => ({
		kind: "agent.message",
		from: "a",
		id,
		replyRequired: false,
		interrupt: false,
	});
	const lines = (s: ReturnType<typeof setup>) => s.fake.entries.flatMap((entry) => wakeLines(entry.data));

	it("lists an event once when its key was already listed in the batch", async () => {
		const s = setup();
		s.gate.emit(mail(7), msg, { triggerTurn: true });
		s.gate.emit(mail(7), msg, { triggerTurn: true });
		s.gate.emit(mail(8), msg, { triggerTurn: true });
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(lines(s).map((line) => line.label)).toEqual(["message #7 from a", "message #8 from a"]);
		// The messages themselves are all sent: only the row line is deduplicated.
		expect(s.fake.sent).toHaveLength(3);
	});

	it("lists the event again in a later batch", async () => {
		const s = setup();
		s.gate.emit(mail(7), msg, { triggerTurn: true });
		await s.fake.emit("agent_start", {}, s.ctx);
		await s.fake.emit("agent_settled", { aborted: false }, s.ctx);
		s.gate.emit(mail(7), msg, { triggerTurn: true });
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(lines(s)).toHaveLength(2);
	});

	it("takes a line back when its send throws, so the next run is not shown as woken by it", async () => {
		const s = setup();
		const send = s.fake.api.session.sendMessage;
		(s.fake.api.session as unknown as { sendMessage: () => never }).sendMessage = () => {
			throw new Error("not ready");
		};
		expect(() => s.gate.emit(mail(1), msg, { triggerTurn: true })).toThrow("not ready");
		(s.fake.api.session as unknown as { sendMessage: typeof send }).sendMessage = send;
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(s.fake.entries).toHaveLength(0);
	});

	it("takes a line back when its send is rejected, and keeps the line of a duplicate that was accepted", async () => {
		const s = setup();
		let reject: (error: Error) => void = () => undefined;
		(s.fake.api.session as unknown as { sendMessage: () => Promise<void> }).sendMessage = () =>
			new Promise<void>((_resolve, fail) => {
				reject = fail;
			});
		const failing = s.gate.emit(mail(1), msg, { triggerTurn: true }) as Promise<void>;
		reject(new Error("nope"));
		await expect(failing).rejects.toThrow("nope");
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(s.fake.entries).toHaveLength(0);
		await s.fake.emit("agent_settled", { aborted: false }, s.ctx);
		// Two sends of one event: one fails, the other stands, so the line stays.
		const first = s.gate.emit(mail(2), msg, { triggerTurn: true }) as Promise<void>;
		const firstReject = reject;
		void s.gate.emit(mail(2), msg, { triggerTurn: true });
		firstReject(new Error("nope"));
		await expect(first).rejects.toThrow("nope");
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(lines(s).map((line) => line.label)).toEqual(["message #2 from a"]);
	});

	it("takes a line back when a held send fails at release", async () => {
		vi.useFakeTimers();
		const s = await active({ subagents: { wakeHoldSeconds: 2 } });
		(s.fake.api.session as unknown as { sendMessage: () => never }).sendMessage = () => {
			throw new Error("closed");
		};
		await s.gate.emit(mail(3), msg, { triggerTurn: true });
		vi.advanceTimersByTime(2000);
		expect(s.store.unread().map((event) => event.topic)).toEqual(["agent.message"]);
		await s.fake.emit("agent_start", {}, s.ctx);
		expect(s.fake.entries).toHaveLength(0);
	});
});
