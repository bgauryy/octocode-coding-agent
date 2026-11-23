import { activity, type ActivityFacts } from "@octocodeai/octocode-projections";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	plainTitle,
	TITLE_FRAME_MS,
	TITLE_STATE,
	type TitleState,
	TitleTracker,
	terminalTitle,
} from "../../src/octocode/ui/terminal-title.ts";
import { setEmojiMarks, TitlePainter } from "@octocodeai/octocode-tui";

describe("terminalTitle emoji marks", () => {
	afterEach(() => setEmojiMarks(false));

	it("starts with the squid only when emoji marks are on", () => {
		expect(terminalTitle("idle", undefined, "/work/repo")).toBe("◈ Idle - repo");
		setEmojiMarks(true);
		expect(terminalTitle("idle", undefined, "/work/repo")).toBe("🦑 Idle - repo");
		expect(terminalTitle("running", "fix login", "/work/repo", 2)).toBe("🦑⠋ Running - fix login · repo · 2 agents");
	});
});

describe("terminalTitle", () => {
	it("reads `◈<mark> <state> - <description> · <folder>` for every state", () => {
		const states = Object.keys(TITLE_STATE) as TitleState[];
		expect(states.map((state) => terminalTitle(state, "fix login", "/work/repo"))).toEqual([
			"◈ Idle - fix login · repo",
			"◈⠋ Thinking - fix login · repo",
			"◈⠋ Running - fix login · repo",
			"◈⏳ Waiting - fix login · repo",
			"◈⚠️ Needs you - fix login · repo",
			"◈🟢 Done - fix login · repo",
			"◈🔴 Error - fix login · repo",
		]);
		expect(terminalTitle("idle", undefined, "/work/repo")).toBe("◈ Idle - repo");
	});

	it("names the agent after the state mark once it has a team name, cleaned and capped", () => {
		expect(terminalTitle("running", "fix login", "/work/repo", 2, 0, "shy-barnacle")).toBe(
			"◈⠋ shy-barnacle Running - fix login · repo · 2 agents",
		);
		expect(terminalTitle("idle", undefined, "/r", 0, 0, "shy-barnacle")).toBe("◈ shy-barnacle Idle - r");
		expect(terminalTitle("done", undefined, "/r", 0, 0, "")).toBe("◈🟢 Done - r");
		const hostile = terminalTitle("done", undefined, "/r", 0, 0, "evil\u001b]0;pwned\u0007\nname");
		expect(hostile).not.toMatch(/[\u0000-\u001f]/);
		expect(hostile).toMatch(/^◈🟢 evil.* Done - r$/);
		expect(terminalTitle("done", undefined, "/r", 0, 0, "n".repeat(80)).length).toBeLessThan(50);
	});

	it("ends with the number of background subagents", () => {
		expect(terminalTitle("running", "fix login", "/work/repo", 2)).toBe("◈⠋ Running - fix login · repo · 2 agents");
		expect(terminalTitle("running", undefined, "/work/repo", 1)).toBe("◈⠋ Running - repo · 1 agent");
		expect(terminalTitle("background", undefined, "/work/repo", 3)).toBe("◈⏳ Waiting - repo · 3 agents");
		expect(terminalTitle("running", undefined, "/work/repo", 0)).toBe("◈⠋ Running - repo");
	});

	it("animates only busy states, frame by frame, and keeps the state word still", () => {
		const frames = [0, 1, 2, 3].map((frame) => terminalTitle("running", undefined, "/r", 0, frame));
		expect(new Set(frames.map((title) => title.split(" ")[0])).size).toBeGreaterThan(1);
		expect(frames.every((title) => title.endsWith(" Running - r"))).toBe(true);
		for (const state of ["idle", "background", "waiting", "done", "failed"] as const)
			expect(terminalTitle(state, undefined, "/r", 0, 1)).toBe(terminalTitle(state, undefined, "/r", 0, 0));
	});

	it("drops escape sequences, flattens and caps a long description", () => {
		expect(terminalTitle("done", "fix \u001b]0;pwned\u0007login", "/work/repo")).toBe("◈🟢 Done - fix login · repo");
		const long = terminalTitle("done", `fix\nthe ${"very ".repeat(20)}long bug`, "/work/repo");
		expect(long).toMatch(/^◈🟢 Done - fix the very .*… · repo$/);
		expect(long.length).toBeLessThan(60);
	});

	it("has a plain title without state for a tab the session has left", () => {
		expect(plainTitle("fix login", "/work/repo")).toBe("fix login · repo");
		expect(plainTitle(undefined, "/work/repo")).toBe("repo");
	});
});

describe("TitlePainter", () => {
	afterEach(() => vi.useRealTimers());

	function painter(initial: TitleState) {
		const written: string[] = [];
		let state = initial;
		const p = new TitlePainter(
			{
				state: () => state,
				target: () => ({ cwd: "/work/repo", setTitle: (text) => written.push(text) }),
				description: () => "fix login",
				agents: () => 0,
			},
			{ full: terminalTitle, plain: plainTitle },
		);
		return { p, written, set: (next: TitleState) => (state = next) };
	}

	it("animates while busy at a slow rate and stops writing once settled", () => {
		vi.useFakeTimers();
		const t = painter("running");
		t.p.paint();
		vi.advanceTimersByTime(TITLE_FRAME_MS * 3);
		expect(t.written).toHaveLength(4);
		expect(new Set(t.written).size).toBeGreaterThan(1);
		t.set("done");
		t.p.paint();
		const settled = t.written.length;
		vi.advanceTimersByTime(TITLE_FRAME_MS * 10);
		expect(t.written).toHaveLength(settled);
		expect(t.written.at(-1)).toBe("◈🟢 Done - fix login · repo");
	});

	it("stops animating when stopped, as at session shutdown", () => {
		vi.useFakeTimers();
		const t = painter("thinking");
		t.p.paint();
		t.p.stop();
		vi.advanceTimersByTime(TITLE_FRAME_MS * 5);
		expect(t.written).toHaveLength(1);
	});
});

describe("TitleTracker", () => {
	// Contract change (RFC app-state T2): the tab's state is the session's activity light, refined during its own run;
	// the outcome and background work come from the light, not from the tracker's events.
	const light = (facts: ActivityFacts) => activity(facts);

	it("follows a run: thinking, running while any tool runs, waiting on a dialog, then the light's outcome until seen", () => {
		const t = new TitleTracker();
		t.toolStart("before-run");
		expect(t.state).toBe("idle");
		t.start();
		expect(t.state).toBe("thinking");
		t.toolStart("a");
		t.toolStart("b");
		t.toolEnd("a");
		expect(t.state).toBe("running");
		t.promptStart("p");
		expect(t.state).toBe("waiting");
		t.promptEnd("p");
		t.toolEnd("b");
		expect(t.state).toBe("thinking");
		t.settle();
		t.setLight(light({ phase: { state: "failed", error: "rate limited" } }));
		expect(t.state).toBe("failed");
		t.seen();
		expect(t.state).toBe("idle");
		// A new outcome is not seen yet.
		t.setLight(light({ phase: { state: "done" } }));
		expect(t.state).toBe("done");
	});

	it("waits while the light works after the run, and shows the outcome once it is final; a timer alone is idle", () => {
		const t = new TitleTracker();
		t.start();
		t.setLight(light({ streaming: true, phase: { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 } }));
		// Its own run still goes on: that run's state wins over the background work.
		expect(t.state).toBe("thinking");
		t.settle();
		t.setLight(light({ phase: { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 } }));
		expect(t.state).toBe("background");
		t.seen();
		expect(t.state).toBe("background");
		t.setLight(light({ status: "compacting" }));
		expect(t.state).toBe("background");
		t.setLight(light({ phase: { state: "stopped", open: ["B1"] } }));
		expect(t.state).toBe("failed");
		t.setLight(light({ phase: { state: "scheduled", timers: 1, id: "t1" } }));
		expect(t.state).toBe("idle");
	});

	it("shows waiting for a blocking dialog or a light that needs you, and ignores a dialog the user opened", () => {
		const t = new TitleTracker();
		t.promptStart("picker", false);
		expect(t.state).toBe("idle");
		t.promptEnd("picker");
		t.promptStart("approval", true);
		expect(t.state).toBe("waiting");
		t.promptEnd("approval");
		t.setLight(light({ awaiting: { kind: "approval", title: "Run it?" } }));
		expect(t.state).toBe("waiting");
		t.setLight(light({ phase: { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 } }));
		expect(t.state).toBe("background");
	});

	it("keeps waiting while any blocking dialog is open, whatever order dialogs open and close in", () => {
		const t = new TitleTracker();
		expect(t.promptStart("picker", false)).toBe(false);
		expect(t.promptStart("approval", true)).toBe(true);
		expect(t.state).toBe("waiting");
		t.promptEnd("picker");
		expect(t.state).toBe("waiting");
		expect(t.promptStart("question", true)).toBe(false);
		t.promptEnd("approval");
		expect(t.state).toBe("waiting");
		t.promptEnd("question");
		expect(t.state).toBe("idle");
	});

	it("keeps a run's state when the user returns mid-run, and reset forgets an open dialog and the light", () => {
		const t = new TitleTracker();
		t.start();
		t.seen();
		expect(t.state).toBe("thinking");
		t.promptStart("p");
		t.setLight(light({ phase: { state: "done" } }));
		t.reset();
		expect(t.state).toBe("idle");
		t.start();
		expect(t.state).toBe("thinking");
		t.promptEnd("p");
		expect(t.state).toBe("thinking");
	});

	it("reads the session's own run from the light before its run events arrive", () => {
		const t = new TitleTracker();
		t.setLight(light({ phase: { state: "working" } }));
		expect(t.state).toBe("thinking");
	});
});
