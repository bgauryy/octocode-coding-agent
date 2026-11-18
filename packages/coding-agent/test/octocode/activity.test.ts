import { animationClock, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkingStatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { titledDialog, withDialog } from "../../src/octocode/shared/locks.ts";
import { Thought, thoughtGist } from "../../src/octocode/render/thought.ts";
import { Activity, callTarget, shortToolName } from "../../src/octocode/ui/activity-model.ts";
import { registerActivity } from "../../src/octocode/ui/activity.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

afterEach(() => vi.useRealTimers());

describe("model event age", () => {
	it("measures silence separately from total run time and resets on same-phase deltas", () => {
		const activity = new Activity();
		activity.start(1000);
		activity.stream("thinking_delta", 10_000, "working");
		expect(activity.modelSilenceMs(40_000)).toBe(30_000);
		activity.stream("thinking_delta", 41_000, "more");
		expect(activity.modelSilenceMs(42_000)).toBe(1000);
		activity.toolStart("tool", "bash", {}, 42_000);
		expect(activity.modelSilenceMs(100_000)).toBeUndefined();
		activity.toolEnd("tool", 100_000);
		expect(activity.modelSilenceMs(101_000)).toBe(1000);
		activity.promptStart("Approval", 102_000);
		expect(activity.modelSilenceMs(150_000)).toBeUndefined();
		activity.end();
		expect(activity.modelSilenceMs(200_000)).toBeUndefined();
	});
});

describe("Activity: consequential calls", () => {
	it("keeps a silent shell command timed without overflowing the working line", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "brew upgrade bun" }, 0);
		activity.consequential("shell", "brew upgrade bun " + "x".repeat(200), false, 0);
		expect(activity.describe()).toMatch(/^shell: brew upgrade bun x+…$/);
		expect(visibleWidth(activity.describe()!)).toBeLessThanOrEqual(70);
		activity.toolEnd("1", 20_000);
		expect(activity.describe()).toBeUndefined();
	});
	it("shows one line per consequential call while its tool runs, at most one a second, bursts collapsed into +n", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "make" }, 0);
		activity.consequential("shell", "make", false, 0);
		expect(activity.describe()).toBe("shell: make");
		// Inside the window the line keeps the first call and counts the rest.
		activity.consequential("shell", "ls", false, 300);
		activity.consequential("web", "https://example.com", false, 600);
		expect(activity.describe()).toBe("shell: make +2");
		// After the window the next call takes the line.
		activity.consequential("web", "https://example.com", false, 1_000);
		expect(activity.describe()).toBe("web: https://example.com");
		activity.toolEnd("1", 1_100);
		expect(activity.describe()).toBeUndefined();
	});

	it("marks a ⚠ call with the warning, and lets it replace a quiet line inside the window", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "x" }, 0);
		activity.consequential("shell", "ls", false, 0);
		activity.consequential("shell.destructive", "rm -rf build", true, 100);
		expect(activity.describe()).toBe("⚠ shell.destructive: rm -rf build");
		// A quiet call does not push a ⚠ line out.
		activity.consequential("shell", "ls", false, 200);
		expect(activity.describe()).toBe("⚠ shell.destructive: rm -rf build +1");
	});

	it("reports nothing back from consequential", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "make" }, 0);
		expect(activity.consequential("shell", "make", false, 0)).toBeUndefined();
		expect(activity.consequential("shell", "ls", false, 100)).toBeUndefined();
	});

	it("drops the line of a call that ends without running (blocked after the check) while other calls still run", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "sleep 9" }, 0);
		activity.toolStart("2", "bash", { command: "rm -rf build" }, 0);
		// The second call's check let it through, and another handler then blocked it: its tool ends at once.
		activity.checking("2", true, 10);
		activity.consequential("shell.destructive", "rm -rf build", true, 10);
		activity.checking("2", false, 20);
		expect(activity.describe()).toBe("⚠ shell.destructive: rm -rf build");
		activity.toolEnd("2", 30);
		expect(activity.describe()).toBe("Running bash sleep 9");
		// A line whose call is another one stays until that one ends.
		activity.checking("1", true, 2_000);
		activity.consequential("shell", "sleep 9", false, 2_000);
		activity.checking("1", false, 2_000);
		activity.toolStart("3", "read", {}, 2_100);
		activity.toolEnd("3", 2_200);
		expect(activity.describe()).toBe("shell: sleep 9");
		activity.toolEnd("1", 2_300);
		expect(activity.describe()).toBeUndefined();
	});

	it("forgets the line when the run ends", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "x" }, 0);
		activity.consequential("shell", "ls", false, 0);
		activity.end();
		activity.start(5_000);
		activity.toolStart("2", "bash", { command: "y" }, 5_000);
		expect(activity.describe()).toBe("Running bash y");
	});
});

describe("Activity: the working-line vocabulary", () => {
	/** Each state of a run and the words the working line shows for it: one verb per state. */
	const states: ReadonlyArray<readonly [string, (activity: Activity) => void, string]> = [
		["model streaming reasoning", (a) => a.stream("thinking_delta", 1), "Thinking"],
		["model streaming text", (a) => a.stream("text_delta", 1), "Writing"],
		["a tool running", (a) => a.toolStart("1", "bash", { command: "yarn test" }, 1), "Running Bash"],
		["an Octocode tool running", (a) => a.toolStart("1", "mcp__octocode__localSearch", {}, 1), "Running localSearch"],
		[
			"a subagent running",
			(a) => a.toolStart("1", "agent", { input: { goal: "review the footer" } }, 1),
			"Running subagent review the footer",
		],
		[
			"a permission ask pending",
			(a) => {
				a.toolStart("1", "bash", { command: "rm -rf build" }, 1);
				a.promptStart(undefined, 2);
			},
			"Waiting for you",
		],
	];

	it.each(states)("%s reads %j", (_state, enter, words) => {
		const activity = new Activity();
		activity.start(0);
		enter(activity);
		expect(activity.working()).toBe(words);
	});

	it("never shows a permission class or an agent id", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "rm -rf build" }, 0);
		activity.consequential("shell.destructive", "rm -rf build", true, 0);
		expect(activity.working()).toBe("⚠ Running Bash: rm -rf build");
		expect(activity.working()).not.toMatch(/shell\.destructive|general-/);
	});
});

describe("Activity", () => {
	it("describes model phases, parallel tools, nested calls and user prompts", () => {
		const activity = new Activity();
		expect(activity.describe()).toBeUndefined();
		activity.start(0);
		expect(activity.describe()).toBeUndefined();
		activity.stream("thinking_delta", 0);
		expect(activity.describe()).toBe("Thinking");
		activity.stream("text_delta", 5_000);
		expect(activity.describe()).toBe("Writing");
		activity.stream("toolcall_start", 9_000);
		expect(activity.describe()).toBe("Preparing tool calls");
		activity.stream("done", 9_000);
		activity.messageDone(9_000);
		expect(activity.describe()).toBeUndefined();
		// Octocode's own "Working" covers the wait for the first token on the stored line.
		expect(activity.describe()).toBeUndefined();

		activity.toolStart("1", "bash", { command: "yarn test\nmore" }, 10_000);
		expect(activity.describe()).toBe("Running bash yarn test");
		activity.toolStart("2", "mcp__octocode__localSearch", { path: "/repo" }, 11_000);
		activity.toolStart("3", "mcp__octocode__localSearch", {}, 11_000);
		expect(activity.describe()).toBe("Running 3 tools: bash · localSearch ×2");
		expect(activity.ticking()).toBe(true);
		activity.promptStart("Pick one", 13_000);
		expect(activity.describe()).toBe("Waiting for you: Pick one");
		activity.promptEnd();
		activity.toolEnd("1", 14_000);
		activity.toolEnd("2", 14_000);
		activity.toolEnd("unknown", 14_000);
		expect(activity.describe()).toBe("Running localSearch");
		activity.toolEnd("3", 15_000);
		expect(activity.describe()).toBeUndefined();
		// Waiting for the model again: the run is still under way.
		expect(activity.ticking()).toBe(true);
		activity.promptStart(undefined, 15_000);
		expect(activity.describe()).toBe("Waiting for you");
		activity.end();
		expect(activity.describe()).toBeUndefined();
		// A message ending after the run ended does not revive it.
		activity.messageDone(16_000);
		expect(activity.phase).toBe("idle");
	});

	it("shows the gist of streaming thinking, changing per sentence", () => {
		expect(thoughtGist("Reading the")).toBeUndefined();
		expect(thoughtGist("**Plan**\nRead the")).toBe("Plan");
		expect(thoughtGist("One. Two")).toBe("One.");
		expect(thoughtGist("One. Two", true)).toBe("Two");
		expect(thoughtGist("Use https://bob:hunter2@example.com/x.", true)).toBe("Use https://example.com/x.");
		expect(thoughtGist("Token is ghp_0123456789abcdefghijklmnopqrstuvwxyzAB.", true)).toContain("[redacted]");
		const activity = new Activity();
		activity.start(0);
		expect(activity.stream("thinking_start", 0)).toBe(true);
		expect(activity.stream("thinking_delta", 0, "Checking the")).toBe(false);
		expect(activity.stream("thinking_delta", 0, " lock order. Then")).toBe(true);
		expect(activity.stream("thinking_delta", 0, " the")).toBe(false);
		// One long unfinished sentence after a heading-like line keeps the last finished thought.
		const thought = new Thought();
		expect(thought.add("Solving it:")).toBe(true);
		expect(thought.add(" bat+ball=1.10, so")).toBe(false);
		expect(thought.gist).toBe("Solving it:");
		// A long unit cut at the front of the kept tail is dropped, never shown in part.
		const long = new Thought();
		long.add(`Key sk-${"x".repeat(2_100)} ends here.`);
		expect(long.gist).toBeUndefined();
		long.add(" Next thought. Then");
		expect(long.gist).toBe("Next thought.");
		expect(activity.describe()).toBe("Thinking: Checking the lock order.");
		activity.stream("thinking_start", 4_000);
		expect(activity.describe()).toBe("Thinking");
	});

	it("shortens MCP tool names and sanitizes hints", () => {
		expect(shortToolName("mcp__octocode__localSearch")).toBe("localSearch");
		expect(shortToolName("mcp__my_server__get_file")).toBe("get_file");
		expect(shortToolName("bash")).toBe("bash");
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "echo \u001b[31mred" }, 0);
		expect(activity.describe()).not.toContain("\u001b");
	});

	it("names what batched calls and agents work on, redacted", () => {
		expect(
			callTarget("file", {
				queries: [
					{ type: "edit", path: "src/a.ts" },
					{ type: "write", path: "b.ts" },
				],
			}),
		).toEqual({ hint: "src/a.ts", more: 1 });
		expect(callTarget("mcp__octocode__localSearch", { queries: [{ pattern: "useState", path: "src" }] })).toEqual({
			hint: "useState in src",
			more: 0,
		});
		expect(callTarget("ghSearchCode", { queries: [{ owner: "o", repo: "r", keywords: ["a", "b"] }, {}, {}] })).toEqual({
			hint: "o/r a b",
			more: 2,
		});
		expect(callTarget("agent", { goal: "Audit auth\nmore lines" })).toEqual({ hint: "Audit auth", more: 0 });
		expect(callTarget("web", { queries: [{ url: "https://me:s3cret@example.com/x" }] }).hint).toBe(
			"https://example.com/x",
		);
		expect(
			callTarget("bash", { command: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" x' })
				.hint,
		).toContain("[redacted]");
		expect(callTarget("agent", { goal: "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789" }).hint).toContain(
			"[redacted]",
		);
		const activity = new Activity();
		activity.start(0);
		activity.toolStart(
			"1",
			"mcp__octocode__localSearch",
			{ queries: [{ pattern: "x".repeat(200), path: "src" }, {}, {}] },
			0,
		);
		const line = activity.describe()!;
		// The clipped target keeps the count of the other queries, within the width.
		expect(line).toMatch(/^Running localSearch x+… \+2$/);
		expect(line.length).toBeLessThanOrEqual(70);
	});

	it("keeps every line within 70 columns and names at most two tools of a batch", () => {
		const activity = new Activity();
		activity.start(0);
		for (const [id, name] of ["bash", "web", "web", "file", "agent"].entries())
			activity.toolStart(String(id), name, {}, 0);
		expect(activity.describe()).toBe("Running 5 tools: bash · web ×2 +2");
		activity.end();
		activity.start(0);
		activity.promptStart(`Which ${"very ".repeat(30)}long question?`, 0);
		expect(activity.describe(2)!.length).toBeLessThanOrEqual(70);
		expect(activity.describe(2)).toMatch(/… \(\+2 queued\)$/);
		activity.promptEnd();
		activity.stream("thinking_delta", 0, `${"Weighing ".repeat(20)}options. Next`);
		expect(activity.describe()!.length).toBeLessThanOrEqual(70);
	});
});

describe("registerActivity", () => {
	it("ticks the working line on the shared animation clock, not its own timer", async () => {
		const unsubscribe = vi.fn();
		const subscribe = vi.spyOn(animationClock, "subscribe").mockReturnValue(unsubscribe);
		const interval = vi.spyOn(globalThis, "setInterval");
		try {
			const fake = fakeHost();
			registerActivity(fake.api, { workingLine: true });
			const ctx = fakeCtx({ cwd: "/x" });
			await fake.emit("agent_start", {}, ctx);
			expect(subscribe).toHaveBeenCalledWith(expect.any(Function), { everyMs: 1000, kind: "info" });
			expect(interval).not.toHaveBeenCalled();
			await fake.emit("agent_settled", { outcome: "completed" }, ctx);
			expect(unsubscribe).toHaveBeenCalledTimes(1);
			await fake.emit("session_shutdown", {}, ctx);
		} finally {
			subscribe.mockRestore();
			interval.mockRestore();
		}
	});

	it("clears activity on settlement, ignoring late streaming events", async () => {
		vi.useFakeTimers();
		try {
			const fake = fakeHost();
			registerActivity(fake.api, { workingLine: true });
			const ctx = fakeCtx({ cwd: "/x" });
			const update = {
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_delta", delta: "A thought." },
			};
			await fake.emit("agent_start", {}, ctx);
			await fake.emit("message_update", update, ctx);
			expect((ctx.ui as { working?: string }).working).toContain("Thinking");
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(31_000);
			expect((ctx.ui as { working?: string }).working).toContain("no model event for 31s");
			await fake.emit("message_update", update, ctx);
			vi.advanceTimersByTime(1000);
			expect((ctx.ui as { working?: string }).working).not.toContain("no model event");
			await fake.emit("agent_settled", { outcome: "aborted" }, ctx);
			await fake.emit("message_update", update, ctx);
			vi.advanceTimersByTime(10_000);
			expect((ctx.ui as { working?: string }).working).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
			await fake.emit("session_shutdown", {}, ctx);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drives the working line and the team activity from Octocode events", async () => {
		vi.useFakeTimers();
		const fake = fakeHost();
		const lines: Array<string | undefined> = [];
		registerActivity(fake.api, { workingLine: true, onChange: (line) => lines.push(line) });
		const ctx = fakeCtx({ cwd: "/x" });
		const ui = ctx.ui as typeof ctx.ui & { working?: string };
		await fake.emit("session_start", {}, ctx);
		await fake.emit("agent_start", {}, ctx);
		await fake.emit(
			"message_update",
			{ message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta" } },
			ctx,
		);
		await fake.emit(
			"message_update",
			{ message: { role: "user" }, assistantMessageEvent: { type: "text_delta" } },
			ctx,
		);
		expect(ui.working).toBe("Thinking");
		await fake.emit("message_end", { message: { role: "assistant" } }, ctx);
		await fake.emit("message_end", { message: { role: "user" } }, ctx);
		await fake.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "sleep 9" } }, ctx);
		// A nested call a tool makes is part of that call.
		await fake.emit(
			"tool_execution_start",
			{ toolCallId: "a/1", parentToolCallId: "a", toolName: "web", args: {} },
			ctx,
		);
		expect(ui.working).toBe("Running Bash");
		vi.advanceTimersByTime(3_000);
		expect(ui.working).toBe("Running Bash");
		await fake.emit("ui_prompt_start", { title: "Continue?" }, ctx);
		expect(ui.working).toBe("Waiting for you: Continue?");
		await fake.emit("ui_prompt_end", {}, ctx);
		await fake.emit("tool_execution_end", { toolCallId: "a/1", parentToolCallId: "a" }, ctx);
		expect(ui.working).toBe("Running Bash");
		await fake.emit("tool_execution_end", { toolCallId: "a" }, ctx);
		expect(ui.working).toBe("Waiting for model");
		await fake.emit("agent_settled", {}, ctx);
		expect(ui.working).toBeUndefined();
		// The team hears state changes only, and keeps the command the working line leaves to the tool row.
		expect(lines).toEqual([
			"Thinking",
			undefined,
			"Running bash sleep 9",
			"Waiting for you: Continue?",
			"Running bash sleep 9",
			undefined,
		]);
		await fake.emit("session_shutdown", {}, ctx);
	});

	it("holds the working spinner still while a tool row animates its own, and restores it after", async () => {
		initTheme("dark", false);
		vi.useFakeTimers();
		const fake = fakeHost();
		registerActivity(fake.api, { workingLine: true });
		const ctx = fakeCtx({ cwd: "/x" });
		const ui = ctx.ui as typeof ctx.ui & { indicator?: { frames: string[] } };
		const tui = { requestRender: vi.fn() } as never;
		await fake.emit("agent_start", {}, ctx);
		await fake.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "sleep 9" } }, ctx);
		expect(ui.indicator?.frames).toHaveLength(1);
		// The real working line, given that indicator, draws the same mark however long it runs.
		const line = new WorkingStatusIndicator(tui, "Running Bash", ui.indicator);
		const first = stripAnsi(line.render(80)[1]);
		vi.advanceTimersByTime(700);
		expect(stripAnsi(line.render(80)[1]).trim().split(" ")[0]).toBe(first.trim().split(" ")[0]);
		line.dispose();
		await fake.emit("tool_execution_end", { toolCallId: "a" }, ctx);
		expect(ui.indicator?.frames.length).toBeGreaterThan(1);
		await fake.emit("agent_settled", {}, ctx);
		await fake.emit("session_shutdown", {}, ctx);
	});

	it("starts the run clock the working line counts from at agent_start and ends it at settlement", async () => {
		initTheme("dark", false);
		vi.useFakeTimers({ now: 5_000 });
		const fake = fakeHost();
		registerActivity(fake.api, { workingLine: true });
		const ctx = fakeCtx({ cwd: "/x" });
		await fake.emit("agent_start", {}, ctx);
		vi.setSystemTime(5_000 + 62_000);
		// An indicator created mid-run (after a retry or compaction) still shows the whole run's time.
		const tui = { requestRender: vi.fn() } as never;
		const midRun = new WorkingStatusIndicator(tui, "Working");
		expect(stripAnsi(midRun.render(80)[1])).toContain("(1m02s");
		midRun.dispose();
		await fake.emit("agent_settled", {}, ctx);
		const after = new WorkingStatusIndicator(tui, "Working");
		expect(stripAnsi(after.render(80)[1])).toContain("(0s");
		after.dispose();
		const child = fakeHost();
		registerActivity(child.api, { workingLine: false });
		await child.emit("agent_start", {}, ctx);
		vi.setSystemTime(5_000 + 70_000);
		const alone = new WorkingStatusIndicator(tui, "Working");
		expect(stripAnsi(alone.render(80)[1])).toContain("(0s");
		alone.dispose();
		await fake.emit("session_shutdown", {}, ctx);
	});

	it("skips the working line for subagents and headless runs", async () => {
		const fake = fakeHost();
		registerActivity(fake.api, { workingLine: false });
		const ctx = fakeCtx({ cwd: "/x" });
		await fake.emit("agent_start", {}, ctx);
		await fake.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: {} }, ctx);
		expect((ctx.ui as { working?: string }).working).toBeUndefined();
		const headless = fakeHost();
		registerActivity(headless.api, { workingLine: true });
		const quiet = fakeCtx({ cwd: "/x", hasUI: false });
		await headless.emit("agent_start", {}, quiet);
		await headless.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: {} }, quiet);
		expect((quiet.ui as { working?: string }).working).toBeUndefined();
	});

	it("paints and ticks only in the TUI: RPC has no working line", async () => {
		vi.useFakeTimers();
		const fake = fakeHost();
		const lines: Array<string | undefined> = [];
		registerActivity(fake.api, { workingLine: true, onChange: (line) => lines.push(line) });
		const rpc = fakeCtx({ cwd: "/x", mode: "rpc" });
		await fake.emit("session_start", {}, rpc);
		await fake.emit("agent_start", {}, rpc);
		await fake.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "ls" } }, rpc);
		expect((rpc.ui as { working?: string }).working).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		// The team still hears the state.
		expect(lines).toEqual(["Running bash ls"]);
		await fake.emit("session_shutdown", {}, rpc);
	});

	it("titles a custom dialog from its opener, since Octocode gives it none", async () => {
		const fake = fakeHost();
		registerActivity(fake.api, { workingLine: true });
		const ctx = fakeCtx({ cwd: "/x" });
		const ui = ctx.ui as typeof ctx.ui & { working?: string };
		await fake.emit("session_start", {}, ctx);
		await fake.emit("agent_start", {}, ctx);
		let close!: () => void;
		const open = titledDialog(
			"2 questions: Which database?",
			() =>
				new Promise<void>((resolve) => {
					close = resolve;
					return close;
				}),
		);
		await fake.emit("ui_prompt_start", { kind: "custom" }, ctx);
		expect(ui.working).toBe("Waiting for you: 2 questions: Which database?");
		await fake.emit("ui_prompt_end", { kind: "custom" }, ctx);
		close();
		await open;
		await fake.emit("ui_prompt_start", { kind: "custom" }, ctx);
		expect(ui.working).toBe("Waiting for you");
		await fake.emit("session_shutdown", {}, ctx);
	});

	it("shows a call's pre-run checks and dialogs queued behind the open one", async () => {
		vi.useFakeTimers();
		const fake = fakeHost();
		const control = registerActivity(fake.api, { workingLine: true });
		const ctx = fakeCtx({ cwd: "/x" });
		const ui = ctx.ui as typeof ctx.ui & { working?: string };
		await fake.emit("session_start", {}, ctx);
		await fake.emit("agent_start", {}, ctx);
		await fake.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "ls" } }, ctx);
		await fake.emit("tool_execution_start", { toolCallId: "b", toolName: "web", args: {} }, ctx);
		control.checking("a", true);
		expect(ui.working).toBe("Checking Bash");
		control.checking("a", false);
		control.checking("missing", true);
		expect(ui.working).toBe("Running 2 tools: Bash · Web");
		let close!: () => void;
		const open = withDialog(
			() =>
				new Promise<void>((resolve) => {
					close = resolve;
					return close;
				}),
		);
		await fake.emit("ui_prompt_start", { title: "Pick" }, ctx);
		const queued = withDialog(async () => undefined);
		await Promise.resolve();
		expect(ui.working).toMatch(/^Waiting for you: Pick \(\+1 queued\)/);
		close();
		await Promise.all([open, queued]);
		await fake.emit("ui_prompt_end", {}, ctx);
		await fake.emit("session_shutdown", {}, ctx);
		vi.useRealTimers();
	});
});

describe("Activity: the working line stays within its columns", () => {
	it.each([
		["ASCII", "build the project with a very long command line that goes on and on past the limit"],
		["CJK", "漢字のとても長い説明文がここにあって端末の幅を超えてしまうほど長く続きます".repeat(2)],
		["emoji", "🚀🔥✨".repeat(30)],
	])("keeps %s detail inside 70 columns", (_name, detail) => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: detail }, 0);
		expect(visibleWidth(activity.describe()!)).toBeLessThanOrEqual(70);
	});

	it("leaves a short ASCII line exactly as written", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "make test" }, 0);
		expect(activity.describe()).toBe("Running bash make test");
	});
});

describe("Activity: the working line", () => {
	it("names one tool without repeating the command its row shows, and drops permission ids", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "bash", { command: "sleep 6; echo done" }, 0);
		activity.consequential("shell", "sleep 6; echo done", false, 0);
		expect(activity.working()).toBe("Running Bash");
		activity.toolStart("2", "mcp__octocode__localSearch", { queries: [{ pattern: "x" }, {}] }, 0);
		expect(activity.working()).toBe("Running 2 tools: Bash · localSearch");
		activity.toolEnd("1", 1);
		expect(activity.working()).toBe("Running localSearch +1");
	});

	it("shows a subagent call with its goal, not the spawn permission sentence", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", "agent", { goal: "Audit the TUI footer" }, 0);
		activity.consequential("agent.spawn", "general may edit files in the repository and run shell commands", true, 0);
		const line = activity.working()!;
		expect(line).toBe("⚠ Running subagent Audit the TUI footer");
		expect(line).not.toContain("agent.spawn");
	});

	it("covers every phase, carries no clock, and falls back to waiting for the model", () => {
		const activity = new Activity();
		expect(activity.working()).toBeUndefined();
		activity.start(0);
		expect(activity.working()).toBe("Waiting for model");
		activity.stream("thinking_delta", 0, "Checking the lock order. Then");
		expect(activity.working()).toBe("Thinking: Checking the lock order.");
		activity.stream("text_delta", 0);
		expect(activity.working()).toBe("Writing");
		activity.stream("toolcall_start", 0);
		expect(activity.working()).toBe("Preparing tool calls");
		activity.promptStart("Pick one", 0);
		expect(activity.working(1)).toBe("Waiting for you: Pick one (+1 queued)");
		activity.promptEnd();
		activity.toolStart("1", "bash", {}, 0);
		activity.checking("1", true, 0);
		expect(activity.working()).toBe("Checking Bash");
	});
});

it("shows only activity details, never a step clock, and keeps no timers", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd: "/work" });
	const ui = ctx.ui as typeof ctx.ui & { working?: string };
	registerActivity(fake.api, { workingLine: true });
	await fake.emit("session_start", {}, ctx);
	await fake.emit("agent_start", {}, ctx);
	expect(ui.working).toBe("Waiting for model");
	const message = { role: "assistant", usage: { input: 100, cacheRead: 200, output: 50 } };
	await fake.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "hello" } }, ctx);
	expect(ui.working).not.toMatch(/Main|tokens|\n/);
	await fake.emit("message_end", { message }, ctx);
	expect(ui.working).not.toMatch(/Main|tokens|\n/);
	await fake.emit("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "sleep 10" } }, ctx);
	vi.advanceTimersByTime(5_000);
	expect(ui.working).toBe("Running Bash");
	await fake.emit("agent_start", {}, ctx);
	expect(ui.working).not.toContain("Main");
	ctx.sessionManager.getEntries = () => [{ type: "compaction" }] as never;
	await fake.emit("session_compact", {}, ctx);
	expect(ui.working).not.toContain("compaction");
	await fake.emit("agent_settled", {}, ctx);
	expect(ui.working).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
	await fake.emit("agent_start", {}, ctx);
	expect(ui.working).toBe("Waiting for model");
	await fake.emit("session_shutdown", {}, ctx);
	expect(vi.getTimerCount()).toBe(0);
});
