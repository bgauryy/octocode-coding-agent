import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { AGENT_RESULT_TYPE } from "../../src/octocode/shared/messages.ts";
import { sessionPhaseOf } from "../../src/octocode/shared/session-phase.ts";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { backlogOpenItems, registerPhaseFeed } from "../../src/octocode/ui/phase-feed.ts";
import { registerNotify } from "../../src/octocode/ui/notify.ts";
import { registerPhaseLine } from "../../src/octocode/ui/phase-line.ts";
import { phaseLine } from "../../src/octocode/ui/phase-line-view.ts";
import { registerTurnLine, TURN_LINE_TYPE, turnLineText } from "../../src/octocode/ui/turn-line.ts";
import { wakeGateOf } from "../../src/octocode/wake/gate.ts";
import { registerWake } from "../../src/octocode/wake/register.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";

afterEach(() => {
	vi.useRealTimers();
});

const turnEntries = (fake: ReturnType<typeof fakeHost>) => fake.entries.filter((e) => e.customType === TURN_LINE_TYPE);

describe("the turn line follows the session's phase", () => {
	function setup() {
		vi.useFakeTimers({ now: 10_000 });
		// The phase without the hold window: a held wake is pinned in wake-gate.test.ts.
		const fake = fakeHost({ subagents: { wakeHoldSeconds: 0 } });
		registerWake(fake.api);
		registerTurnLine(fake.api);
		const ctx = fakeCtx({ cwd: "/x" });
		const recorded: unknown[] = [];
		const queue = new ReportQueue(fake.api);
		queue.start({ getSessionFile: () => undefined, getEntries: () => recorded as never }, () => true);
		const work = runningWorkOf(fake.api);
		const phase = sessionPhaseOf(fake.api);
		const run = async (seconds: number, tools = 1) => {
			await fake.emit("agent_start", {}, ctx);
			for (let index = 0; index < tools; index++)
				await fake.emit("tool_execution_start", { toolCallId: `t${index}`, toolName: "bash" }, ctx);
			vi.advanceTimersByTime(seconds * 1000);
			await fake.emit("agent_end", { messages: [] }, ctx);
		};
		// As the host does: the settle ends once the sends deferred by agent_settled handlers ran.
		const settling = () => fake.emit("agent_settled", { aborted: false }, ctx);
		const settleEnd = () => fake.emit("agent_settle_end", {}, ctx);
		const settle = async () => {
			await settling();
			await settleEnd();
		};
		return { fake, ctx, queue, recorded, work, phase, run, settle, settling, settleEnd };
	}

	it("waits while a background child runs, and writes one line after the report's run settles", async () => {
		const s = setup();
		try {
			await s.run(5);
			s.work.setBackground(["kid"]);
			await s.settle();
			expect(s.phase.phase().state).toBe("waiting");
			expect(turnEntries(s.fake)).toEqual([]);
			vi.advanceTimersByTime(20_000);

			// The child's report is queued before it leaves the background list: nothing is final in between.
			s.queue.add({
				content: "kid done",
				details: { id: "kid", status: "done", outcome: "done", summary: "Done" },
				wake: true,
				reportId: "r1",
			});
			s.work.setBackground([]);
			expect(s.phase.phase()).toEqual({ state: "resuming", label: "report from kid" });
			expect(turnEntries(s.fake)).toEqual([]);

			s.queue.flush();
			expect(s.fake.sent).toHaveLength(1);
			expect(s.phase.phase().state).toBe("resuming");
			await s.run(3, 0);
			// The session recorded the report when its run started.
			s.recorded.push({ type: "custom_message", customType: AGENT_RESULT_TYPE, details: { reportId: "r1" } });
			expect(turnEntries(s.fake)).toEqual([]);
			await s.settle();
			expect(turnEntries(s.fake)).toEqual([
				{ customType: TURN_LINE_TYPE, data: { ms: 8_000, waitedMs: 20_000, tools: 1 } },
			]);
			expect(s.phase.phase().state).toBe("done");
		} finally {
			s.queue.persist();
		}
	});

	it("writes the line when the work drains and no wake follows", async () => {
		const s = setup();
		await s.run(5);
		s.work.setBackground(["kid"]);
		s.work.set("bash", [{ kind: "bash", id: "bash-1", title: "build" }]);
		await s.settle();
		vi.advanceTimersByTime(60_000);
		s.work.setBackground([]);
		expect(turnEntries(s.fake)).toEqual([]);
		s.work.set("bash", []);
		expect(turnEntries(s.fake)).toEqual([
			{ customType: TURN_LINE_TYPE, data: { ms: 5_000, waitedMs: 60_000, tools: 1 } },
		]);
		s.work.setBackground(["later"]);
		s.work.setBackground([]);
		expect(turnEntries(s.fake)).toHaveLength(1);
	});

	it("keeps the job open for a timer until it is gone", async () => {
		const s = setup();
		s.work.set("timer", [{ kind: "timer", id: "#4", title: "wait", dueAt: 400_000 }]);
		await s.run(5);
		await s.settle();
		expect(s.phase.phase().state).toBe("scheduled");
		expect(turnEntries(s.fake)).toEqual([]);
		s.work.set("timer", []);
		expect(turnEntries(s.fake)).toHaveLength(1);
	});

	it("stays final for a run with nothing outstanding, as before", async () => {
		const s = setup();
		await s.run(62, 5);
		await s.settle();
		expect(turnEntries(s.fake)).toEqual([{ customType: TURN_LINE_TYPE, data: { ms: 62_000, tools: 5 } }]);
	});

	it("counts a wake sent while the run settles until its turn starts, or the settle ends without one", async () => {
		const s = setup();
		const wake = () =>
			wakeGateOf(s.fake.api).emit(
				{ kind: "agent.report", agent: "kid", role: "agent", outcome: "done", reportId: "g1" },
				{ customType: AGENT_RESULT_TYPE, content: "done", display: true },
				{ triggerTurn: true },
			);
		// The host defers a send made while the run settles; the run it starts begins before the settle ends.
		await s.run(5);
		s.work.setBackground(["kid"]);
		await s.settling();
		wake();
		s.work.setBackground([]);
		expect(s.phase.phase().state).toBe("resuming");
		await s.run(2, 0);
		await s.settle();
		await s.settleEnd();
		expect(turnEntries(s.fake)).toHaveLength(1);

		// A deferred send that started no run (a refused wake) counts until the settle ends, however long that takes.
		await s.run(5);
		await s.settle();
		expect(turnEntries(s.fake)).toHaveLength(2);
		s.work.setBackground(["kid"]);
		await s.run(4);
		s.work.setBackground(["kid", "kid2"]);
		await s.settling();
		wake();
		s.work.setBackground([]);
		expect(s.phase.phase().state).toBe("resuming");
		vi.advanceTimersByTime(10_000);
		expect(s.phase.phase().state).toBe("resuming");
		expect(turnEntries(s.fake)).toHaveLength(2);
		await s.settleEnd();
		expect(turnEntries(s.fake)).toHaveLength(3);

		// An idle session's send that started no run stops counting at once: nothing will start it later.
		s.work.setBackground(["kid"]);
		await s.run(3);
		await s.settle();
		wake();
		s.work.setBackground([]);
		expect(turnEntries(s.fake)).toHaveLength(4);
	});

	it("renders the waited time and open items, and still renders old entries", () => {
		expect(turnLineText({ ms: 242_000, waitedMs: 649_000, tools: 42, agents: 4, cost: 2.09, cache: 96 })).toBe(
			"✻ Worked 4m02s · waited 10m49s · 42 tools · 4 agents · ≈$2.09 · cache 96%",
		);
		expect(turnLineText({ ms: 5_000, open: ["B12", "B13"] })).toBe("✻ Worked 5s · 2 items still open");
		expect(turnLineText({ ms: 5_000, waitedMs: 400, open: [] })).toBe("✻ Worked 5s");
		expect(turnLineText({ ms: 62_000, tools: 5 })).toBe("✻ Worked 1m02s · 5 tools");
	});
});

describe("open items at settle", () => {
	let tmp: string;
	let savedDb: string | undefined;
	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-phase-items-")));
		savedDb = process.env.OCTOCODE_AGENT_DB;
		process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
	});
	afterEach(() => {
		closeSharedAgentDb();
		if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
		else process.env.OCTOCODE_AGENT_DB = savedDb;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("stops with the ongoing items this session holds, and the line says so", async () => {
		const fake = fakeHost();
		registerPhaseFeed(fake.api, backlogOpenItems);
		registerTurnLine(fake.api);
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd });
		const backlog = openBacklog(ctx, { isSubagent: false });
		const item = backlog.store.add({
			goal: "Expected result",
			why: "Required work",
			title: "held",
			state: "todo",
			createdBy: "user",
			paths: [],
		});
		const ref = backlog.store.update(item.ref, { state: "ongoing" }, backlog.actor).ref;
		vi.useFakeTimers({ now: 10_000 });
		await fake.emit("agent_start", {}, ctx);
		vi.advanceTimersByTime(5_000);
		await fake.emit("agent_end", { messages: [] }, ctx);
		await fake.emit("agent_settled", { aborted: false }, ctx);
		expect(sessionPhaseOf(fake.api).phase()).toEqual({ state: "stopped", open: [ref] });
		expect(turnEntries(fake)).toEqual([{ customType: TURN_LINE_TYPE, data: { ms: 5_000, open: [ref], tools: 0 } }]);
	});
});

describe("the live line", () => {
	it("draws waiting, resuming and scheduled, and nothing during a run or after the job", () => {
		vi.useFakeTimers({ now: 100_000 });
		const store = sessionPhaseOf({});
		const line = phaseLine({ requestRender: () => undefined }, theme, store);
		try {
			expect(line.render(80)).toEqual([]);
			store.startRun();
			vi.advanceTimersByTime(65_000);
			expect(line.render(80)).toEqual([]);
			store.setWork({ agents: 4, queued: 0, bash: 1, external: 0, timers: [] });
			store.settleRun({ status: "done" }, []);
			expect(rendered(line)).toBe("\n ◐ Waiting on 4 agents · 1 bash (1m05s)");
			store.setWork({
				agents: 0,
				queued: 0,
				bash: 0,
				external: 0,
				timers: [{ id: "#4", dueAt: 165_000 + 5 * 60_000 }],
			});
			expect(rendered(line)).toBe("\n ◇ Waiting for timer #4 · in 5m (1m05s)");
			store.setWork({ agents: 0, queued: 0, bash: 0, external: 0, timers: [] });
			expect(line.render(80)).toEqual([]);
		} finally {
			line.dispose();
		}
	});

	it("mounts above the editor while the session waits and removes itself when it is done", async () => {
		const fake = fakeHost();
		registerPhaseLine(fake.api);
		const ctx = fakeCtx({ cwd: "/x" });
		await fake.emit("session_start", {}, ctx);
		expect(ctx.ui.widgets.has("octocode-phase")).toBe(false);
		await fake.emit("agent_start", {}, ctx);
		expect(ctx.ui.widgets.has("octocode-phase")).toBe(false);
		runningWorkOf(fake.api).setBackground(["kid"]);
		await fake.emit("agent_settled", { aborted: false }, ctx);
		expect(ctx.ui.widgets.has("octocode-phase")).toBe(true);
		runningWorkOf(fake.api).setBackground([]);
		expect(ctx.ui.widgets.has("octocode-phase")).toBe(false);
		await fake.emit("session_shutdown", {}, ctx);
	});

	it("is not mounted outside the terminal UI", async () => {
		const fake = fakeHost();
		registerPhaseLine(fake.api);
		const ctx = fakeCtx({ cwd: "/x", mode: "rpc" });
		await fake.emit("session_start", {}, ctx);
		runningWorkOf(fake.api).setBackground(["kid"]);
		expect(ctx.ui.widgets.has("octocode-phase")).toBe(false);
	});
});

describe("the desktop notice", () => {
	it("says the answer is ready when the job ends, not when a run settles with agents still working", async () => {
		const fake = fakeHost();
		(fake.api.session as { getName: () => undefined }).getName = () => undefined;
		const writes: string[] = [];
		registerNotify(fake.api, {
			env: { OCTOCODE_NOTIFY: "always", OCTOCODE_NOTIFY_METHOD: "osc9" },
			write: (d) => writes.push(d),
		});
		const ctx = fakeCtx({ cwd: "/work/repo", ui: { onTerminalInput: () => () => undefined } as never });
		await fake.fire("session_start", {}, ctx);
		const answer = (text: string) => ({
			messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
		});
		const notices = () => writes.filter((write) => write.includes("answer ready"));
		await fake.fire("agent_start", {}, ctx);
		runningWorkOf(fake.api).setBackground(["kid"]);
		await fake.fire("agent_end", answer("Started a child"), ctx);
		await fake.fire("agent_settled", { aborted: false }, ctx);
		expect(notices()).toEqual([]);
		runningWorkOf(fake.api).setBackground([]);
		expect(notices()).toEqual(["\x1b]9;Octocode: answer ready: Started a child\x07"]);
	});
});

describe("coordinate list", () => {
	const member = (id: string, patch: Record<string, unknown> = {}) =>
		({
			id,
			role: "main",
			status: "idle",
			pid: 1,
			joinedAt: 0,
			updatedAt: 0,
			...patch,
		}) as never;

	it("says a parent whose children work is waiting on them, not idle", () => {
		const text = describeMembers(
			[
				member("main-a"),
				member("kid-1", { role: "general", status: "working", parentId: "main-a" }),
				member("kid-2", { role: "general", status: "working", parentId: "main-a" }),
				member("kid-3", { role: "general", status: "idle", parentId: "main-a" }),
				member("other"),
			],
			"main-a",
			1_000,
		);
		const block = (id: string) => text.split(/\n(?=\S)/).find((part) => part.startsWith(id)) ?? "";
		expect(block("main-a")).toContain("\n  waiting on 2 agents");
		expect(block("main-a")).not.toMatch(/\n {2}idle/);
		expect(block("main-a").split("\n")[0]).toMatch(/^main-a \(you\) · \S+ · waiting\b/);
		expect(block("main-a").split("\n")[0]).not.toContain("idle");
		expect(block("other").split("\n")[0]).toContain("· idle");
		expect(block("kid-3").split("\n")[0]).toContain("· idle");
		expect(block("other")).toMatch(/\n {2}idle/);
		expect(block("kid-3")).toMatch(/\n {2}idle/);
	});
});
