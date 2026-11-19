import { animationClock, GLYPH, MOTION, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { collapsedRows } from "../../src/octocode/team/panel/rows.ts";
import { type Moving, PanelMotion } from "../../src/octocode/team/panel/motion.ts";
import { panelMark, panelState } from "../../src/octocode/team/panel/state.ts";
import { AgentsView } from "../../src/octocode/team/panel.ts";
import { markFrameMs, WAIT_PULSE_MS } from "../../src/theme/status.ts";
import { openWidgetLines as widgetLines } from "./two-line-panel.ts";
import { fakeCtx, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const NOW = 1_000_000;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
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

afterEach(() => {
	animationClock.setReducedMotion(false);
	vi.useRealTimers();
});

describe("panel state", () => {
	it("maps working to running, idle and departed agents to pending", () => {
		const working = { member: member("a", { status: "working" }), depth: 0 };
		const idle = { member: member("b"), depth: 0 };
		const gone = { member: member("c", { status: "working" }), depth: 0, doneAt: NOW - 1_000 };
		expect(panelState(working, NOW)).toEqual({ state: "running", label: "working" });
		expect(panelState(idle, NOW)).toEqual({ state: "pending", label: "idle" });
		expect(panelState(gone, NOW)).toEqual({ state: "pending", label: "left" });
	});

	it("draws the state marks: the light for every state, working or not", () => {
		const team = [
			member("main-aaaaaa"),
			member("busy-aaaa", { parentId: "main-aaaaaa", status: "working" }),
			member("rest-bbbb", { parentId: "main-aaaaaa" }),
		];
		const rows = widgetLines(team, "main-aaaaaa", NOW, theme, 120);
		// The mark alone says the state: no state word, and no stats line for an agent without stats.
		// The elapsed time ends each row at the terminal's edge.
		const edge = (left: string, right: string) =>
			`${left}${" ".repeat(120 - visibleWidth(left) - visibleWidth(right))}${right}`;
		expect(rows).toEqual([
			edge(" 🦑 main-aaaaaa ⏺ · general", "1m"),
			edge(` ├ ⏺ busy-aaaa    · general`, "1m"),
			edge(" └ ⏺ rest-bbbb    · general", "1m"),
		]);
		const tree = [
			{ member: team[1], depth: 0 },
			{ member: team[2], depth: 0 },
			{ member: team[2], depth: 0, doneAt: NOW - 20_000 },
		];
		const compact = collapsedRows(tree, NOW, theme, 120).map((row) => row.slice(0, 5));
		expect(compact).toEqual([` ├ ⏺ `, " ├ ⏺ ", " └ ⏺ "]);
	});

	it("holds the light steady in reduced motion", () => {
		animationClock.setReducedMotion(true);
		const state = panelState({ member: member("a", { status: "working" }), depth: 0 }, NOW);
		expect(panelMark(theme, state, NOW + 80)).toBe(GLYPH.light);
	});

	it("keeps the root row free of a tally: each agent's mark says it works, and `left` is on the ↳ line", () => {
		const team = [
			member("main-aaaaaa"),
			member("a-1111", { parentId: "main-aaaaaa", status: "working" }),
			member("b-2222", { parentId: "main-aaaaaa", status: "working" }),
		];
		const done = [{ member: member("c-3333", { parentId: "main-aaaaaa" }), at: NOW - 1_000 }];
		const lines = widgetLines(team, "main-aaaaaa", NOW, theme, 120, [], undefined, done);
		expect(lines).toEqual([
			" 🦑 main-aaaaaa ⏺ · general                                                                                           1m",
			" ├ ⏺ a-1111       · general                                                                                           1m",
			" ├ ⏺ b-2222       · general                                                                                           1m",
			" └ ⏺ c-3333       · general                                                                                          59s",
			"     ↳ left",
		]);
	});
});

describe("panel motion", () => {
	const working: Moving = { state: "running" };
	const idle: Moving = { state: "pending" };

	it("subscribes while an agent works and lets go once none does, leaving the clock stopped", () => {
		let marks: Moving[] = [working];
		const repaint = vi.fn();
		const motion = new PanelMotion(() => marks, repaint);
		motion.sync(NOW);
		expect(motion.active).toBe(true);
		expect(animationClock.isRunning()).toBe(true);
		marks = [idle, { state: "done", since: NOW - 10_000 }];
		motion.sync(NOW);
		expect(motion.active).toBe(false);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("never subscribes for a still panel or in reduced motion", () => {
		const motion = new PanelMotion(() => [idle], vi.fn());
		motion.sync(NOW);
		expect(motion.active).toBe(false);
		animationClock.setReducedMotion(true);
		const busy = new PanelMotion(() => [working], vi.fn());
		busy.sync(NOW);
		expect(busy.active).toBe(false);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("repaints on ticks and unsubscribes itself when the agents settle", () => {
		vi.useFakeTimers();
		let marks: Moving[] = [working];
		const repaint = vi.fn();
		const motion = new PanelMotion(() => marks, repaint);
		motion.sync();
		vi.advanceTimersByTime(MOTION.backgroundSpinnerMs * 3);
		expect(repaint.mock.calls.length).toBeGreaterThanOrEqual(2);
		marks = [idle];
		vi.advanceTimersByTime(MOTION.backgroundSpinnerMs);
		const painted = repaint.mock.calls.length;
		expect(motion.active).toBe(false);
		vi.advanceTimersByTime(1_000);
		expect(repaint.mock.calls.length).toBe(painted);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("repaints a running light at the calm light cadence, and stops once nothing moves", () => {
		vi.useFakeTimers();
		let marks: Moving[] = [working];
		const repaint = vi.fn();
		const motion = new PanelMotion(() => marks, repaint);
		motion.sync();
		vi.advanceTimersByTime(2_000);
		const frames = repaint.mock.calls.length;
		expect(frames).toBeGreaterThanOrEqual(Math.floor(2_000 / markFrameMs("running", { light: true })) - 1);
		expect(frames).toBeLessThanOrEqual(Math.ceil(2_000 / MOTION.backgroundSpinnerMs));
		marks = [{ state: "failed" }, { state: "waiting", since: NOW - 60_000 }];
		vi.advanceTimersByTime(MOTION.backgroundSpinnerMs);
		expect(motion.active).toBe(false);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("glows a fresh done mark at the slower glow cadence, then stops", () => {
		vi.useFakeTimers();
		const since = Date.now();
		const motion = new PanelMotion(() => [{ state: "done", since }], vi.fn());
		motion.sync();
		expect(motion.active).toBe(true);
		vi.advanceTimersByTime(MOTION.flashMs + MOTION.glowFrameMs * 2);
		expect(motion.active).toBe(false);
	});

	it("dispose ends the subscription", () => {
		const motion = new PanelMotion(() => [working], vi.fn());
		motion.sync(NOW);
		motion.dispose();
		expect(motion.active).toBe(false);
		expect(animationClock.isRunning()).toBe(false);
	});
});

describe("AgentsView motion", () => {
	it("animates the mounted panel only while an agent works, and not after it stops", () => {
		vi.useFakeTimers();
		const now = Date.now();
		const peer = (status: Member["status"]) =>
			member("worker-1a2b", { parentId: "me-0001", status, toolCalls: 2, joinedAt: now - 20_000, updatedAt: now });
		let members = [member("me-0001", { updatedAt: now }), peer("working")];
		const team = {
			id: "me-0001",
			get view() {
				return { members: members.map((entry) => ({ ...entry, updatedAt: Date.now() })), traffic: [] };
			},
			watch(listener: () => void) {
				const timer = setInterval(listener, 1_000);
				listener();
				return () => clearInterval(timer);
			},
		};
		const view = new AgentsView(team as never);
		const ctx = fakeCtx({ cwd: tmp() });
		view.start(ctx);
		const factory = ctx.ui.widgets.get("octocode-agents") as (tui: unknown, theme: unknown) => unknown;
		const requestRender = vi.fn();
		factory({ requestRender }, theme);
		expect(animationClock.isRunning()).toBe(true);
		requestRender.mockClear();
		vi.advanceTimersByTime(MOTION.backgroundSpinnerMs * 5);
		expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(4);
		// The worker goes idle: the next data refresh drops the animation subscription.
		members = [members[0], peer("idle")];
		vi.advanceTimersByTime(1_000);
		expect(animationClock.isRunning()).toBe(false);
		requestRender.mockClear();
		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();
		view.stop(ctx);
	});

	it("breathes a waiting agent's mark for WAIT_PULSE_MS from when it began to wait, then stops requesting frames", () => {
		vi.useFakeTimers();
		const now = Date.now();
		const members = [
			member("me-0001", { updatedAt: now }),
			member("asker-1a2b", { parentId: "me-0001", status: "working", waiting: "approval", joinedAt: now - 20_000 }),
		];
		const team = {
			id: "me-0001",
			get view() {
				return { members: members.map((entry) => ({ ...entry, updatedAt: Date.now() })), traffic: [] };
			},
			watch(listener: () => void) {
				const timer = setInterval(listener, 1_000);
				listener();
				return () => clearInterval(timer);
			},
		};
		const view = new AgentsView(team as never);
		const ctx = fakeCtx({ cwd: tmp() });
		view.start(ctx);
		const factory = ctx.ui.widgets.get("octocode-agents") as (tui: unknown, theme: unknown) => unknown;
		const requestRender = vi.fn();
		factory({ requestRender }, theme);
		expect(animationClock.isRunning()).toBe(true);
		vi.advanceTimersByTime(WAIT_PULSE_MS - 1_000);
		expect(animationClock.isRunning()).toBe(true);
		// Past the pulse the mark holds still while the agent keeps waiting: no clock, no frames.
		vi.advanceTimersByTime(2_000);
		expect(animationClock.isRunning()).toBe(false);
		// Between data refreshes (each second) nothing repaints.
		vi.advanceTimersByTime(1_000 - ((Date.now() - now) % 1_000) + 10);
		requestRender.mockClear();
		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();
		view.stop(ctx);
	});
});
