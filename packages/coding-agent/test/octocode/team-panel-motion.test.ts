import { animationClock, GLYPH, MOTION, SPINNER } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { collapsedRows } from "../../src/octocode/team/panel/compact.ts";
import { type Moving, PanelMotion } from "../../src/octocode/team/panel/motion.ts";
import { panelMark, panelState } from "../../src/octocode/team/panel/state.ts";
import { AgentsView, widgetLines } from "../../src/octocode/team/panel.ts";
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

	it("draws the state marks: spinner frame for working, ○ for idle and departed", () => {
		const frame = SPINNER.braille[Math.floor(NOW / MOTION.spinnerMs) % SPINNER.braille.length];
		const team = [
			member("main-aaaaaa"),
			member("busy-aaaa", { parentId: "main-aaaaaa", status: "working" }),
			member("rest-bbbb", { parentId: "main-aaaaaa" }),
		];
		const rows = widgetLines(team, "main-aaaaaa", NOW, theme, 120);
		expect(rows[1]).toMatch(new RegExp(`^ ├ ${frame} busy-aaaa`));
		expect(rows[2]).toMatch(/^ └ ○ rest-bbbb/);
		const tree = [
			{ member: team[1], depth: 0 },
			{ member: team[2], depth: 0 },
			{ member: team[2], depth: 0, doneAt: NOW - 20_000 },
		];
		const compact = collapsedRows(tree, NOW, theme, 120).map((row) => row.slice(0, 3));
		expect(compact).toEqual([` ${frame} `, " ○ ", " ○ "]);
	});

	it("freezes the spinner on its first frame in reduced motion", () => {
		animationClock.setReducedMotion(true);
		const state = panelState({ member: member("a", { status: "working" }), depth: 0 }, NOW);
		expect(panelMark(theme, state, NOW + 80)).toBe(GLYPH.running);
	});

	it("says how many agents work and have left in the root row", () => {
		const team = [
			member("main-aaaaaa"),
			member("a-1111", { parentId: "main-aaaaaa", status: "working" }),
			member("b-2222", { parentId: "main-aaaaaa", status: "working" }),
		];
		const done = [{ member: member("c-3333", { parentId: "main-aaaaaa" }), at: NOW - 1_000 }];
		const lines = widgetLines(team, "main-aaaaaa", NOW, theme, 120, [], undefined, done);
		expect(lines[0]).toBe(" ● main-aaaaaa  general  2 working · 1 left");
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
		vi.advanceTimersByTime(MOTION.spinnerMs * 3);
		expect(repaint.mock.calls.length).toBeGreaterThanOrEqual(2);
		marks = [idle];
		vi.advanceTimersByTime(MOTION.spinnerMs);
		const painted = repaint.mock.calls.length;
		expect(motion.active).toBe(false);
		vi.advanceTimersByTime(1_000);
		expect(repaint.mock.calls.length).toBe(painted);
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
		vi.advanceTimersByTime(MOTION.spinnerMs * 5);
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
});
