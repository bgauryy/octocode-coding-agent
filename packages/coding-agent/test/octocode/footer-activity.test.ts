import { activity } from "@octocodeai/octocode-projections";
import { GLYPH, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { type FooterState, footerLines } from "../../src/octocode/ui/footer/rows.ts";

type Opened = (port: { sessionId: string; stateSource: unknown }) => void;
const ports = vi.hoisted(() => ({
	byId: new Map<string, { sessionId: string; stateSource: unknown }>(),
	opened: new Set<(port: { sessionId: string; stateSource: unknown }) => void>(),
}));
vi.mock("../../src/core/application/index.ts", async (original) => ({
	...(await original<object>()),
	getApplicationPortForSession: (id: string) => ports.byId.get(id),
	onApplicationPortOpened: (listener: Opened) => {
		ports.opened.add(listener);
		return () => ports.opened.delete(listener);
	},
}));
const { followSessionActivity } = await import("../../src/octocode/activity/session-activity.ts");

const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
const tagged = { fg: (tone: string, text: string) => `<${tone}>${text}`, bold: (text: string) => text };
const colourless = { ...plain, getColorMode: () => "none" };
const base: FooterState = {
	model: "claude-opus-5-5",
	thinking: "high",
	usage: { input: 1_000, cacheRead: 0, output: 100, cost: 0.1, unpriced: false },
	cwd: "/work/app",
};
const bottom = (state: FooterState, width = 120, theme: object = plain) =>
	footerLines(state, "main", new Map(), theme as never, width)[1];

describe("the footer's activity light", () => {
	it("leads the model with the light and a word for every state but idle", () => {
		// The footer is still: a working light is the full ⏺ with its word, never a spinner frame held still.
		expect(bottom({ ...base, activity: activity({ streaming: true }) })).toMatch(/^⏺ working · claude-opus-5-5:high/);
		expect(bottom({ ...base, activity: activity({ awaiting: true }) })).toMatch(/^◇ needs you · claude-opus-5-5:high/);
		expect(bottom({ ...base, activity: activity({ phase: { state: "failed", error: "401" } }) })).toMatch(
			/^✗ failed · claude-opus-5-5:high/,
		);
		expect(bottom({ ...base, activity: activity({ status: "retrying" }) })).toMatch(/^⏺ retrying · claude/);
		expect(bottom({ ...base, activity: activity({ phase: { state: "done" } }) })).toMatch(/^○ claude-opus-5-5:high/);
		// Without a light (a host that never published one) the line is as before.
		expect(bottom(base)).toMatch(/^claude-opus-5-5:high/);
	});

	it("paints the light in its tone and the word loud only when it asks for attention", () => {
		// ⏺ means running only: waiting draws ◇ and idle ○, each in its tone.
		expect(bottom({ ...base, activity: activity({ awaiting: true }) }, 120, tagged)).toMatch(
			/^<warning>◇ <warning>needs you<dim> · <accent>claude/,
		);
		expect(bottom({ ...base, activity: activity({ streaming: true }) }, 120, tagged)).toMatch(
			/^<success>⏺ <muted>working<dim> · <accent>claude/,
		);
		expect(bottom({ ...base, activity: activity({}) }, 120, tagged)).toMatch(/^<dim>○ <accent>claude/);
	});

	it("drops the word before the model is cut, and keeps the light as long as the model shows", () => {
		const waiting = { ...base, activity: activity({ awaiting: true }), sessionName: "auth flow" };
		expect(bottom(waiting, 40)).toMatch(/^◇ claude-opus-5-5:high/);
		for (const width of [20, 30, 40, 60, 80]) {
			const line = bottom(waiting, width);
			expect(line.startsWith(GLYPH.waiting), `${width}: ${line}`).toBe(true);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows each state's own glyph without colour", () => {
		const shown = (facts: Parameters<typeof activity>[0]) =>
			bottom({ ...base, activity: activity(facts) }, 120, colourless).slice(0, 1);
		expect([shown({ awaiting: true }), shown({ phase: { state: "failed", error: "x" } }), shown({})]).toEqual([
			GLYPH.waiting,
			GLYPH.failed,
			GLYPH.pending,
		]);
		// Without colour no settled state uses ⏺, so the full ⏺ stands for working.
		expect(shown({ streaming: true })).toBe(GLYPH.light);
	});
});

describe("followSessionActivity", () => {
	afterEach(() => {
		ports.byId.clear();
		ports.opened.clear();
	});
	const stateOf = (over: object = {}) =>
		createStore<Record<string, unknown>>(() => ({ streaming: false, status: "idle", ...over }));

	it("reads the session port's application state now and on each change of the light only", () => {
		const store = stateOf();
		ports.byId.set("s1", { sessionId: "s1", stateSource: store });
		const seen: string[] = [];
		const stop = followSessionActivity("s1", (next) => seen.push(`${next.tone}:${next.label}`));
		store.setState({ streaming: true });
		// Streaming deltas change the state but not the light: no new call.
		store.setState({ streaming: true, status: "idle" });
		store.setState({ awaiting: { kind: "approval", title: "Run bash?" } });
		store.setState({ awaiting: undefined, streaming: false, status: "compacting" });
		store.setState({ status: "idle", phase: { state: "failed", error: "401" } });
		stop();
		store.setState({ streaming: true });
		expect(seen).toEqual(["idle:idle", "working:working", "waiting:needs you", "working:compacting", "error:failed"]);
	});

	it("starts idle and follows a port that opens later for the same session only", () => {
		const seen: string[] = [];
		const stop = followSessionActivity("s2", (next) => seen.push(next.tone));
		for (const listener of ports.opened) listener({ sessionId: "other", stateSource: stateOf({ streaming: true }) });
		const store = stateOf({ awaiting: { kind: "question" } });
		for (const listener of ports.opened) listener({ sessionId: "s2", stateSource: store });
		store.setState({ awaiting: undefined, streaming: true });
		stop();
		expect(ports.opened.size).toBe(0);
		expect(seen).toEqual(["idle", "waiting", "working"]);
	});
});
