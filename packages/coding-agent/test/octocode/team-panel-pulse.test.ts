import type { Member } from "@octocodeai/octocode-contracts/team";
import { animationClock, LIGHT_GLYPH, MOTION } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsView } from "../../src/octocode/team/panel.ts";
import { fakeCtx, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const tagged = { ...(theme as object), fg: (tone: string, text: string) => `<${tone}>${text}` } as never;

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	status: "idle",
	joinedAt: 0,
	updatedAt: 0,
	toolCalls: 2,
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

/** A mounted panel over a fake team; `agent` is the one child's state, which a test changes between ticks. */
function mount(agent: () => Partial<Member>) {
	const joined = Date.now() - 20_000;
	const team = {
		id: "me-0001",
		get view() {
			const now = Date.now();
			return {
				members: [
					member("me-0001", { updatedAt: now, joinedAt: joined }),
					member("worker-1a2b", { parentId: "me-0001", joinedAt: joined, updatedAt: now, ...agent() }),
				],
				traffic: [],
			};
		},
		poll: () => undefined,
		watch(listener: () => void) {
			const timer = setInterval(listener, 1_000);
			listener();
			return () => clearInterval(timer);
		},
	};
	const view = new AgentsView(team as never);
	const ctx = fakeCtx({ cwd: tmp() });
	view.start(ctx);
	const factory = ctx.ui.widgets.get("octocode-agents") as (
		tui: unknown,
		theme: unknown,
	) => { render(width: number): string[] };
	const requestRender = vi.fn();
	const widget = factory({ requestRender }, tagged);
	/** The child's light: the `<tone>glyph` that precedes its name. */
	const light = () =>
		widget
			.render(120)
			.join("\n")
			.match(/(<\w+>\S)\s+<text>worker-1a2b/)?.[1];
	return { view, ctx, light, requestRender };
}

describe("subagent light in the panel", () => {
	it("alternates a working child between yellow and grey on clock ticks and releases the clock on dispose", () => {
		vi.useFakeTimers();
		const { view, ctx, light } = mount(() => ({ status: "working" }));
		expect(animationClock.isRunning()).toBe(true);
		const frames: Array<string | undefined> = [];
		for (let tick = 0; tick < 4; tick++) {
			frames.push(light());
			vi.advanceTimersByTime(MOTION.tickMs);
		}
		expect(new Set(frames)).toEqual(new Set([`<warning>${LIGHT_GLYPH.running}`, `<muted>${LIGHT_GLYPH.running}`]));
		for (let tick = 1; tick < frames.length; tick++) expect(frames[tick]).not.toBe(frames[tick - 1]);
		view.stop(ctx);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("holds a waiting child steady yellow with no clock subscriber and no timer beyond the team read", () => {
		vi.useFakeTimers();
		const { view, ctx, light } = mount(() => ({ status: "working", waiting: "approval" }));
		const timers = vi.getTimerCount();
		const first = light();
		expect(first).toBe(`<warning>${LIGHT_GLYPH.waiting}`);
		expect(animationClock.isRunning()).toBe(false);
		vi.advanceTimersByTime(MOTION.tickMs * 3);
		expect(light()).toBe(first);
		expect(animationClock.isRunning()).toBe(false);
		expect(vi.getTimerCount()).toBe(timers);
		view.stop(ctx);
	});

	it("drops the clock when the working child goes idle", () => {
		vi.useFakeTimers();
		let status: Member["status"] = "working";
		const { view, ctx } = mount(() => ({ status }));
		expect(animationClock.isRunning()).toBe(true);
		status = "idle";
		vi.advanceTimersByTime(MOTION.tickMs * 2);
		expect(animationClock.isRunning()).toBe(false);
		view.stop(ctx);
	});
});
