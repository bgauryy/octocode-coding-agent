import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { closeSharedAgentDb } from "../../../../db/src/api.ts";
import { idleAgentMs } from "../../../src/octocode/monitor/attention/idle-agent.ts";
import { ATTENTION_RULES } from "../../../src/octocode/monitor/attention/rules.ts";
import { monitorLedgerOf } from "../../../src/octocode/monitor/ledger.ts";
import { registerCollab } from "../../../src/octocode/native/tools/coordinate/tool.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../../src/octocode/shared/messages.ts";
import { describeMembers } from "../../../src/octocode/team/member-list.ts";
import { sessionPhaseOf } from "../../../src/octocode/shared/session-phase.ts";
import { STATUS } from "../../../src/octocode/shared/status.ts";
import { SELF_IDLE_TYPE } from "../../../src/octocode/team/session/idle.ts";
import { Team } from "../../../src/octocode/team/session.ts";
import { TeamStore } from "../../../src/octocode/team/store.ts";
import { registerPhaseFeed } from "../../../src/octocode/ui/phase-feed.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 3, 0, 0);

let tmp: string;
let savedDb: string | undefined;
const cleanups: Array<() => unknown> = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-idle-agent-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.useRealTimers();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const at = (minutes: number) => vi.setSystemTime(T0 + minutes * MIN);

const member = (id: string, status: Member["status"], parentId?: string): Member => ({
	id,
	role: id.split("-")[0],
	...(parentId ? { parentId } : {}),
	pid: process.pid,
	status,
	joinedAt: T0,
	updatedAt: T0,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

/** A main session with the real team, its events and phase feed; `child` adds a running child with progress at T0. */
async function session(options: { child?: Member["status"]; settings?: Record<string, unknown> } = {}) {
	const fake = fakeHost(options.settings ?? {});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const dbFile = path.join(tmp, "team.sqlite");
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	registerPhaseFeed(fake.api);
	registerCollab(fake.api, team, {});
	const ctx = fakeCtx({ cwd });
	await fake.emit("session_start", {}, ctx);
	cleanups.push(() => fake.emit("session_shutdown", {}, ctx));
	const opened = TeamStore.open(cwd, dbFile);
	cleanups.push(() => opened.close());
	// Rows other processes keep alive with their heartbeat: saved again on each look, as those processes would.
	const rows: Member[] = [];
	const store = { save: (row: Member) => (rows.push(row), opened.save(row)) };
	if (options.child) {
		store.save(member("c-1", options.child, "p-1"));
		team.setResumer((() => undefined) as never, new Map([["c-1", {}]]));
		team.approvals.noteOutput("c-1", T0);
	}
	const parentTold = () => fake.sent.filter((entry) => entry.message.customType === INTERNAL_MESSAGE_TYPE);
	const selfTold = () => fake.sent.filter((entry) => entry.message.customType === SELF_IDLE_TYPE);
	const rule = () =>
		monitorLedgerOf(fake.api)
			.rules()
			.find((state) => state.rule === "idle-agent")!;
	const check = (minutes: number) => {
		at(minutes);
		for (const row of rows) opened.save({ ...row, updatedAt: Date.now() });
		team.deliverMail();
	};
	return { fake, ctx, team, store, parentTold, selfTold, rule, check };
}

describe("idle-agent: a replaced session", () => {
	it("a tick after session replacement neither throws nor tells anyone", async () => {
		const s = await session({ child: "working" });
		// What the host's feature runtime does to a captured api after /new, /reload, fork or switch.
		vi.spyOn(s.fake.api.settings, "get").mockImplementation(() => {
			throw new Error("This feature ctx is stale after session replacement or reload.");
		});
		expect(() => s.check(5)).not.toThrow();
		expect(s.parentTold()).toHaveLength(0);
	});

	it("other failures still surface", async () => {
		const s = await session({ child: "working" });
		vi.spyOn(s.fake.api.settings, "get").mockImplementation(() => {
			throw new Error("settings unreadable");
		});
		expect(() => s.check(5)).toThrow("settings unreadable");
	});
});

describe("idle-agent: a child", () => {
	it("wakes the parent once at exactly the threshold, within the wake pace, and records it", async () => {
		const s = await session({ child: "working" });
		s.check(5);
		expect(s.parentTold()).toHaveLength(1);
		expect(s.parentTold()[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		for (const minutes of [6, 7, 10, 30]) s.check(minutes);
		expect(s.parentTold()).toHaveLength(1);
		await settle();
		expect(s.rule()).toMatchObject({ alerts: 1, lastValue: 5, threshold: 5, subject: "c-1", state: "tripped" });
	});

	it("says nothing below the threshold, and looks at most once a minute", async () => {
		const s = await session({ child: "working" });
		s.check(4.99);
		// The next look is a minute after the last: 5 minutes of silence is not read until 5.99.
		s.check(5.5);
		expect(s.parentTold()).toEqual([]);
		s.check(5.99);
		expect(s.parentTold()).toHaveLength(1);
	});

	it("re-arms when the child makes progress, and tells the next silence once", async () => {
		const s = await session({ child: "working" });
		s.check(5);
		await settle();
		at(6);
		s.team.approvals.noteOutput("c-1", Date.now());
		s.check(7);
		await settle();
		expect(s.rule().state).toBe("ok");
		s.check(10);
		expect(s.parentTold()).toHaveLength(1);
		s.check(11);
		s.check(12);
		expect(s.parentTold()).toHaveLength(2);
		await settle();
		expect(s.rule()).toMatchObject({ alerts: 2, state: "tripped" });
	});

	it("turns the wake into a note when the wake pace is spent", async () => {
		const s = await session({ child: "working" });
		// The pace is spent by a wake just before the look.
		at(5);
		s.team.wakePace.record();
		s.check(5);
		expect(s.parentTold().map((entry) => entry.options)).toEqual([{ triggerTurn: false, deliverAs: "steer" }]);
	});

	it("excuses a child that is not working, waits on the user, or waits on its own working child", async () => {
		const idle = await session({ child: "idle" });
		idle.check(20);
		expect(idle.parentTold()).toEqual([]);
		await idle.fake.emit("session_shutdown", {}, idle.ctx);

		const asking = await session({ child: "working" });
		asking.team.approvals.set("c-1", true);
		asking.check(20);
		expect(asking.parentTold()).toEqual([]);
		// The answer came: the next look a minute later tells it.
		asking.team.approvals.set("c-1", false);
		asking.check(21);
		expect(asking.parentTold()).toHaveLength(1);
		await asking.fake.emit("session_shutdown", {}, asking.ctx);

		const waiting = await session({ child: "working" });
		waiting.store.save(member("g-1", "working", "c-1"));
		waiting.check(20);
		expect(waiting.parentTold()).toEqual([]);
	});

	it("does not measure a child resumed into a full pool until it starts, and lists it as queued", async () => {
		const s = await session({ child: "working" });
		// Its previous run's output is old; the resume waits for a slot.
		s.team.approvals.noteQueued("c-1");
		for (const minutes of [5, 6, 10, 30]) s.check(minutes);
		expect(s.parentTold()).toEqual([]);
		const listed = s.team.snapshot().members.find((row) => row.id === "c-1")!;
		expect(listed.lastOutputAt).toBeUndefined();
		expect(describeMembers([listed], "p-1", Date.now())).toContain("queued");
		expect(describeMembers([listed], "p-1", Date.now())).not.toContain("stalled");
		// A slot frees at 30 minutes: silence counts from the start, and normal detection resumes.
		s.team.approvals.noteStarted("c-1", Date.now());
		s.check(34);
		expect(s.parentTold()).toEqual([]);
		s.check(35);
		expect(s.parentTold()).toHaveLength(1);
	});

	it("is off at 0, and reads idleAgentMinutes before the deprecated silence keys", async () => {
		const off = await session({ child: "working", settings: { monitor: { idleAgentMinutes: 0, silenceMinutes: 2 } } });
		off.check(60);
		expect(off.parentTold()).toEqual([]);
		expect(idleAgentMs(undefined)).toBe(5 * MIN);
		expect(idleAgentMs({ monitor: { silenceMinutes: 2 }, subagents: { silenceMinutes: 7 } })).toBe(2 * MIN);
		expect(idleAgentMs({ subagents: { silenceMinutes: 7 } })).toBe(7 * MIN);
		expect(idleAgentMs({ monitor: { idleAgentMinutes: -1, silenceMinutes: 3 } })).toBe(3 * MIN);
	});

	it("replaces child silence: one rule, one alert for a long silence", async () => {
		expect(ATTENTION_RULES.map((rule) => rule.id)).not.toContain("silence");
		const s = await session({ child: "working", settings: { monitor: { silenceMinutes: 10 } } });
		for (let minutes = 1; minutes <= 60; minutes++) s.check(minutes);
		expect(s.parentTold()).toHaveLength(1);
		await settle();
		expect(s.rule()).toMatchObject({ alerts: 1, threshold: 10, lastValue: 10 });
	});
});

describe("idle-agent: a main session", () => {
	it("notes itself once and marks the footer, clearing the mark on progress", async () => {
		const s = await session();
		await s.fake.emit("agent_start", {}, s.ctx);
		s.check(5);
		expect(s.selfTold()).toHaveLength(1);
		expect(s.selfTold()[0].options).toEqual({ triggerTurn: false, deliverAs: "steer" });
		expect(s.ctx.ui.statuses.get(STATUS.idleAgent)).toBeDefined();
		s.check(6);
		expect(s.selfTold()).toHaveLength(1);
		await s.fake.emit("message_update", {}, s.ctx);
		expect(s.ctx.ui.statuses.get(STATUS.idleAgent)).toBeUndefined();
		await settle();
		expect(s.rule()).toMatchObject({ alerts: 1, lastValue: 5, subject: s.team.id });
		expect(s.parentTold()).toEqual([]);
	});

	it("is not told while idle between runs", async () => {
		const s = await session();
		await s.fake.emit("agent_start", {}, s.ctx);
		await s.fake.emit("agent_settled", { aborted: false }, s.ctx);
		s.check(30);
		expect(s.selfTold()).toEqual([]);
	});

	it("is excused while a dialog waits on the user, or while its agents or jobs run", async () => {
		const s = await session();
		await s.fake.emit("agent_start", {}, s.ctx);
		await s.fake.emit("ui_prompt_start", { id: "q-1", blocking: true, kind: "select", title: "Pick one" }, s.ctx);
		s.check(10);
		expect(s.selfTold()).toEqual([]);
		await s.fake.emit("ui_prompt_end", { id: "q-1" }, s.ctx);
		sessionPhaseOf(s.fake.api).setWork({ agents: 1, queued: 0, bash: 0, external: 0, timers: [] });
		s.check(11);
		expect(s.selfTold()).toEqual([]);
		sessionPhaseOf(s.fake.api).setWork({ agents: 0, queued: 0, bash: 0, external: 0, timers: [] });
		s.check(12);
		expect(s.selfTold()).toHaveLength(1);
	});
});
