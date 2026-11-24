import os from "node:os";
import path from "node:path";
import { animationClock, MOTION, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAgo, formatDuration, formatSpan } from "../../src/octocode/shared/format.ts";
import { recordCheck } from "../../src/octocode/shared/locks.ts";
import { resultBlock, toolHeader } from "../../src/octocode/render/tool.ts";
import { wholeSeconds } from "../../src/octocode/shared/util.ts";
import { rendered, theme } from "./fake-host.ts";
import { appKey, clip, clipColumns, expandKey, plural, queryTarget } from "../../src/octocode/shared/text.ts";
import { stopRowTimers, timed, timedTool, timingOf } from "../../src/octocode/render/rows.ts";
import type { ToolRow } from "../../src/octocode/render/types.ts";

const row = (overrides: Record<string, unknown> = {}) => ({
	state: {} as ToolRow,
	invalidate: vi.fn(),
	executionStarted: false,
	isPartial: true,
	isError: false,
	expanded: false,
	...overrides,
});

// Still marks by default: the rows below pin text. "tool row motion" turns motion back on.
beforeEach(() => animationClock.setReducedMotion(true));
afterEach(() => {
	vi.useRealTimers();
	stopRowTimers();
	animationClock.setReducedMotion(false);
});

/** Tags each colour token, so a mark's colour reads in the text. */
const tagged = { ...(theme as object), fg: (color: string, text: string) => `<${color}>${text}` } as never;

/** A running row's light: the full ⏺, still with motion on or reduced. A row never draws a spinner frame. */
const STILL_RUN = "⏺";

describe("format helpers", () => {
	it.each([
		[0, "0ms"],
		[850, "850ms"],
		[1_200, "1.2s"],
		[2_000, "2s"],
		[5_960, "6s"],
		[9_400, "9.4s"],
		[59_000, "59s"],
		[65_000, "1m05s"],
		[900_000, "15m"],
		[3_780_000, "1h03m"],
		[7_200_000, "2h"],
		[-5, "0ms"],
	])("formatDuration(%d, true) = %s", (ms, text) => expect(formatDuration(ms, true)).toBe(text));

	it.each([
		[0, "0s ago"],
		[45_000, "45s ago"],
		[125_000, "2m ago"],
		[3_600_000, "1h ago"],
		[19_200_000, "5h20m ago"],
		[90_000_000, "1d1h ago"],
		[86_400_000 * 3, "3d ago"],
		[-5, "0s ago"],
	])("formatAgo(%d) = %s: the one relative-time format, coarser than formatDuration", (ms, text) =>
		expect(formatAgo(ms)).toBe(text),
	);

	it("formatSpan is formatAgo without the suffix; wholeSeconds rounds", () => {
		expect(formatSpan(125_000)).toBe("2m");
		expect(wholeSeconds(1_499)).toBe(1);
		expect(wholeSeconds(1_500)).toBe(2);
	});

	it("clipColumns cuts by terminal columns, never inside a character, and leaves ASCII as clip does", () => {
		expect(clipColumns("abcdef", 4)).toBe(clip("abcdef", 4));
		expect(clipColumns("abc", 4)).toBe("abc");
		const wide = clipColumns("漢字漢字漢字", 7);
		expect(wide).toBe("漢字漢…");
		expect(visibleWidth(wide)).toBeLessThanOrEqual(7);
		const emoji = clipColumns("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 5);
		expect(visibleWidth(emoji)).toBeLessThanOrEqual(5);
		expect(emoji.endsWith("…")).toBe(true);
		expect(clipColumns("x", 0)).toBe("");
	});

	it("pluralizes, clips and falls back to ctrl+o for the expand key", () => {
		expect(plural(1, "line")).toBe("1 line");
		expect(plural(2, "tool use")).toBe("2 tool uses");
		expect(plural(3, "query", "queries")).toBe("3 queries");
		expect(clip("abcdef", 4)).toBe("abc…");
		expect(clip("\u001b]0;evil\u0007ok\nsecond", 10)).toBe("ok");
		expect(expandKey()).toMatch(/\S/);
	});

	it("finds the search text of a query before its path", () => {
		expect(queryTarget({ path: ".", searchText: "add" })).toBe("add in .");
		expect(queryTarget({ owner: "o", repo: "r", keywords: ["a", "b"] })).toBe("o/r a b");
		expect(queryTarget({ owner: "o", repo: "r", path: "src" })).toBe("o/r/src");
		expect(queryTarget({ path: "src/index.ts" })).toBe("src/index.ts");
	});
});

describe("toolHeader", () => {
	it("shows ○ before execution without a time", () => {
		expect(rendered(toolHeader(theme, row(), "Bash", "ls"))).toBe("○ Bash(ls)");
	});

	it("draws each phase as its light: grey, yellow, green while running, quiet when done, red", () => {
		vi.useFakeTimers();
		const mark = (context: ReturnType<typeof row>, options?: { state: "waiting" }) =>
			// ⏺ means running only: each settled phase draws its own circle (○ ◐ ◉ ⊗ ⊘), in its colour.
			rendered(toolHeader(tagged, context, "Bash", "ls", options)).match(/^<(\w+)>[○◐⏺◉⊗⊘]/);
		try {
			expect(mark(row())?.[1]).toBe("dim");
			expect(mark(row({ executionStarted: true, toolCallId: "call-phase" }))?.[1]).toBe("warning");
			void timed(async (_id: string) => ({ content: [] }))("call-phase");
			const running = rendered(toolHeader(tagged, row({ executionStarted: true }), "Bash", "ls"));
			// Contract change (user request): a tool row is grey while it runs, green once its result returned, red on error.
			expect(running).toMatch(new RegExp(`^<muted>${STILL_RUN} `));
			const done = rendered(
				toolHeader(tagged, row({ executionStarted: true, isPartial: false, durationMs: 1_500 }), "Bash", "ls"),
			);
			expect(done).toContain("<success>◉");
			expect(running).toContain("· 0ms");
			expect(done).toContain("· 1.5s");
			expect(mark(row({ isPartial: false, isError: true }))?.[1]).toBe("error");
		} finally {
			stopRowTimers();
		}
	});

	it("ticks while running and stops the ticker on the final result", () => {
		vi.useFakeTimers();
		const context = row({ executionStarted: true });
		const header = toolHeader(theme, context, "Bash", "sleep 2");
		expect(rendered(header)).toMatch(new RegExp(`^${STILL_RUN} Bash\\(sleep 2\\) · 0ms$`));
		expect(context.state.ticking).toBe(true);
		vi.advanceTimersByTime(2_100);
		expect(context.invalidate).toHaveBeenCalledTimes(2);
		const doneContext = { ...context, isPartial: false, durationMs: 1_900 };
		const done = toolHeader(theme, { ...doneContext, lastComponent: header }, "Bash", "sleep 2");
		expect(done).toBe(header);
		expect(rendered(done)).toBe("◉ Bash(sleep 2) · 1.9s");
		expect(context.state.ticking).toBe(false);
		vi.advanceTimersByTime(5_000);
		expect(context.invalidate).toHaveBeenCalledTimes(2);
		expect(rendered(toolHeader(theme, doneContext, "Bash", "sleep 2"))).toBe("◉ Bash(sleep 2) · 1.9s");
	});

	it("ticks every running row on its own: an older row keeps its time while a newer one runs", () => {
		vi.useFakeTimers();
		try {
			const older = row({ executionStarted: true });
			toolHeader(theme, older, "Bash", "build");
			vi.advanceTimersByTime(1_100);
			expect(older.invalidate).toHaveBeenCalledTimes(1);
			const newer = row({ executionStarted: true });
			toolHeader(theme, newer, "Read", "a.ts");
			vi.advanceTimersByTime(3_000);
			expect(older.invalidate).toHaveBeenCalledTimes(4);
			expect(newer.invalidate.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(rendered(toolHeader(theme, older, "Bash", "build"))).toMatch(
				new RegExp(`^${STILL_RUN} Bash\\(build\\) · 4\\.1s$`),
			);
		} finally {
			stopRowTimers();
			vi.useRealTimers();
		}
	});

	it("asks for a frame only when the elapsed text changes", () => {
		vi.useFakeTimers();
		try {
			const context = row({ executionStarted: true });
			toolHeader(theme, context, "Bash", "build");
			// Past ten seconds the text reads whole seconds: ticks that land in the same second draw the same text.
			vi.advanceTimersByTime(12_000);
			const calls = context.invalidate.mock.calls.length;
			vi.advanceTimersByTime(1_000);
			expect(context.invalidate.mock.calls.length).toBe(calls + 1);
			expect(context.state.tickedText).toBe("13s");
		} finally {
			stopRowTimers();
			vi.useRealTimers();
		}
	});

	it("says waiting while the call waits for its checks or approval, and starts the clock when its run begins", async () => {
		vi.useFakeTimers();
		try {
			const context = row({ executionStarted: true, toolCallId: "call-wait" });
			expect(rendered(toolHeader(theme, context, "Bash", "ls"))).toBe("◐ Bash(ls) · waiting");
			vi.advanceTimersByTime(5_000);
			// Nothing to tick while waiting.
			expect(context.invalidate).not.toHaveBeenCalled();
			expect(rendered(toolHeader(theme, context, "Bash", "ls"))).toBe("◐ Bash(ls) · waiting");
			const run = timed(async (_id: string) => {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				return { content: [] };
			});
			const done = run("call-wait");
			// The run's start redraws the row at once.
			expect(context.invalidate).toHaveBeenCalledTimes(1);
			expect(rendered(toolHeader(theme, context, "Bash", "ls"))).toMatch(
				new RegExp(`^${STILL_RUN} Bash\\(ls\\) · 0ms$`),
			);
			await vi.advanceTimersByTimeAsync(2_000);
			await done;
			expect(rendered(toolHeader(theme, context, "Bash", "ls"))).toMatch(
				new RegExp(`^${STILL_RUN} Bash\\(ls\\) · 2s$`),
			);
			// Octocode's duration (the run only) matches the live clock.
			expect(rendered(toolHeader(theme, { ...context, isPartial: false, durationMs: 2_000 }, "Bash", "ls"))).toBe(
				"◉ Bash(ls) · 2s",
			);
		} finally {
			stopRowTimers();
			vi.useRealTimers();
		}
	});

	it("starts an exclusive tool clock before its lock, as Octocode times execute", async () => {
		const tool = timedTool(
			{
				name: "t",
				label: "T",
				description: "",
				parameters: {} as never,
				execute: async () => ({ content: [], details: {} }),
			},
			{ exclusive: true },
		);
		const context = row({ executionStarted: true, toolCallId: "call-lock" });
		toolHeader(theme, context, "T", "x");
		const pending = tool.execute("call-lock", {} as never, undefined, undefined, {} as never);
		expect(rendered(toolHeader(theme, context, "T", "x"))).toMatch(new RegExp(`^${STILL_RUN} T\\(x\\) · \\d+ms$`));
		await pending;
		stopRowTimers();
	});

	it("folds batch sub-lines while collapsed: three, then +N more", () => {
		const sub = Array.from({ length: 10 }, (_, index) => `query ${index}`);
		const collapsed = rendered(toolHeader(theme, row(), "localSearch", "10 queries", { lines: sub })).split("\n");
		expect(collapsed).toEqual([
			"○ localSearch(10 queries)",
			"  query 0",
			"  query 1",
			"  query 2",
			`  … +7 more (${expandKey()} to expand)`,
		]);
		expect(
			rendered(toolHeader(theme, row({ expanded: true }), "localSearch", "10 queries", { lines: sub })).split("\n"),
		).toHaveLength(11);
		// Folding one line would not save one.
		expect(rendered(toolHeader(theme, row(), "x", "4 queries", { lines: sub.slice(0, 4) })).split("\n")).toHaveLength(
			5,
		);
	});

	it("caches its lines per width until the next set, so octocode-tui sees the same strings each frame", () => {
		const header = toolHeader(theme, row(), "Bash", "ls");
		const first = header.render(80);
		expect(header.render(80)).toBe(first);
		expect(header.render(60)).not.toBe(first);
		const again = toolHeader(theme, row({ lastComponent: header }), "Bash", "pwd");
		expect(again).toBe(header);
		expect(rendered(again)).toBe("○ Bash(pwd)");
	});

	it("marks errors with the red light and clips to the width while keeping the time", () => {
		const header = toolHeader(
			theme,
			row({ isPartial: false, isError: true, durationMs: 1_500 }),
			"Web",
			"x".repeat(100),
			{ meta: "bg" },
		);
		const text = rendered(header, 40);
		// A failed row draws ⊗ in red: ⏺ means running only.
		expect(text.startsWith("⊗ Web(xxx")).toBe(true);
		const red = rendered(toolHeader(tagged, row({ isPartial: false, isError: true }), "Web", "x"));
		expect(red).toContain("<error>⊗");
		expect(text.endsWith(") · bg · 1.5s")).toBe(true);
		expect(visibleWidth(text)).toBeLessThanOrEqual(40);
	});

	it("sanitizes the name, summary and sub-lines", () => {
		const text = rendered(toolHeader(theme, row(), "N\u001b[31m", "a\u001b]8;;http://x\u0007b", { lines: ["sub"] }));
		expect(text).toBe("○ N(ab)\n  sub");
	});

	it("shows native duration immediately for restored rows without a result-driven redraw", async () => {
		const context = row({ isPartial: false, durationMs: 1_200 });
		expect(rendered(toolHeader(theme, context, "Read", "a.ts"))).toBe("◉ Read(a.ts) · 1.2s");
		resultBlock(theme, context, { summary: "Read 3 lines" });
		await Promise.resolve();
		expect(context.invalidate).not.toHaveBeenCalled();
	});

	it("names a finished row's duration only from one second; a running row keeps its clock", () => {
		for (const ms of [0, 21, 999]) {
			expect(rendered(toolHeader(theme, row({ isPartial: false, durationMs: ms }), "Bash", "ls"))).toBe("◉ Bash(ls)");
		}
		expect(rendered(toolHeader(theme, row({ isPartial: false, durationMs: 1_000 }), "Bash", "ls"))).toBe(
			"◉ Bash(ls) · 1s",
		);
		expect(rendered(toolHeader(theme, row({ isPartial: false, durationMs: 125_000 }), "Bash", "ls"))).toBe(
			"◉ Bash(ls) · 2m05s",
		);
	});

	it("does not invent completed durations when Octocode has no recorded timing", () => {
		const context = row({ isPartial: false, state: { startedAt: Date.now() - 5_000, durationMs: 1_200 } });
		expect(rendered(toolHeader(theme, context, "Read", "a.ts"))).toBe("◉ Read(a.ts)");
		expect(rendered(toolHeader(theme, { ...context, durationMs: 0 }, "Read", "a.ts"))).toBe("◉ Read(a.ts)");
	});
});

describe("resultBlock", () => {
	const body = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");

	it("keeps every line within a width narrower than the body indent", () => {
		const block = resultBlock(theme, { expanded: true }, { summary: "page", body: "first line\nsecond line" });
		for (const width of [1, 3, 4])
			for (const line of block.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("skips blank lines in the collapsed preview but keeps them when expanded", () => {
		const text = "# Title\n\nSource: x\n\n\npara\nmore";
		expect(rendered(resultBlock(theme, { isPartial: true }, { summary: "page", body: text }))).toBe(
			"  ⎿  page\n     # Title\n     Source: x\n     para\n     more",
		);
		expect(rendered(resultBlock(theme, { expanded: true }, { summary: "page", body: text })).split("\n")).toHaveLength(
			8,
		);
	});

	it("closes a finished row to its summary line, keeping a lone line that has no summary", () => {
		expect(rendered(resultBlock(theme, row({ isPartial: false }), { summary: "10 lines", body }))).toBe(
			`  ⎿  10 lines (${expandKey()} to expand)`,
		);
		expect(rendered(resultBlock(theme, row({ isPartial: false }), { summary: "", body: "only" }))).toBe("  ⎿  only");
		const failed = rendered(resultBlock(theme, row({ isPartial: false, isError: true }), { summary: "exit 1", body }));
		expect(failed).toContain("line 4");
		expect(rendered(resultBlock(theme, row({ isPartial: false }), { summary: "x", body, max: 2 }))).toContain("line 1");
	});

	it("shows a running body of up to twelve lines whole, without an expand hint", () => {
		const text = rendered(resultBlock(theme, row({ isPartial: true }), { summary: "10 lines", body }));
		expect(text.split("\n")).toHaveLength(11);
		expect(text).not.toContain("to expand");
	});

	it("collapses a longer running body to the summary, five lines and an expand hint", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		expect(rendered(resultBlock(theme, row({ isPartial: true }), { summary: "20 lines", body: long }))).toBe(
			[
				"  ⎿  20 lines",
				"     line 0",
				"     line 1",
				"     line 2",
				"     line 3",
				"     line 4",
				`     … +15 lines (${expandKey()} to expand)`,
			].join("\n"),
		);
	});

	it("draws the gutter once per block: wrapped body lines hang under the text", () => {
		const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
		const wrapped = rendered(resultBlock(theme, { expanded: true }, { summary: "", body: words }), 30).split("\n");
		expect(wrapped.length).toBeGreaterThan(1);
		expect(wrapped[0].startsWith("  ⎿  alpha")).toBe(true);
		for (const line of wrapped.slice(1)) expect(line.startsWith("     ")).toBe(true);
		expect(wrapped.join("\n").match(/⎿/g)).toHaveLength(1);
		const withSummary = rendered(
			resultBlock(theme, { expanded: true }, { summary: "done", body: `${words}\n${words}` }),
			30,
		);
		expect(withSummary.match(/⎿/g)).toHaveLength(1);
	});

	it.each(["MCP request aborted", "This operation was aborted", "Operation aborted"])(
		"draws an aborted call as interrupted, not as an error: %s",
		(summary) => {
			const text = rendered(resultBlock(theme, { isError: true }, { summary }));
			expect(text).toContain(summary);
			expect(text).not.toContain("Error:");
		},
	);

	it("still draws other MCP failures as errors", () => {
		for (const summary of ["MCP request timed out after 60000ms", "MCP connection closed"])
			expect(rendered(resultBlock(theme, { isError: true }, { summary }))).toContain(`Error: ${summary}`);
	});

	it("breaks a long error on word boundaries", () => {
		const summary = "Path '/nonexistent-xyz' is outside allowed directories";
		const text = rendered(resultBlock(theme, { isError: true }, { summary, max: 0 }), 30);
		const words = new Set(`Error: ${summary} (${expandKey()} to expand)`.split(" "));
		for (const word of text.replace("⎿", " ").split(/\s+/).filter(Boolean)) expect(words.has(word), word).toBe(true);
		expect(text.split("\n").length).toBeGreaterThan(1);
	});

	it("previews the tail with a hint that counts the earlier lines, first", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		expect(
			rendered(resultBlock(theme, row({ isPartial: false }), { summary: "exit 0", body: long, tail: true, max: 2 })),
		).toBe(
			["  ⎿  exit 0", `     … +18 earlier lines (${expandKey()} to expand)`, "     line 18", "     line 19"].join("\n"),
		);
	});

	it("wraps an error summary whole under the gutter instead of clipping it", () => {
		const message = "edit src/index.ts: the file was not read in this session; read it first, then retry the edit";
		const text = rendered(resultBlock(theme, row({ isPartial: false, isError: true }), { summary: message }), 40);
		expect(text).not.toContain("…");
		expect(text.split("\n")[0]).toMatch(/^ {2}⎿ {2}Error: /);
		expect(
			text
				.split("\n")
				.slice(1)
				.every((line) => line.startsWith("     ")),
		).toBe(true);
		expect(text.replace(/\s+/g, " ")).toContain("then retry the edit");
	});

	it("shows everything when expanded, wrapped to the width", () => {
		const text = rendered(
			resultBlock(theme, row({ isPartial: false, expanded: true }), {
				summary: "s",
				body: `${body}\n${"y".repeat(50)}`,
			}),
			30,
		);
		expect(text.split("\n")).toHaveLength(1 + 10 + 2);
		expect(text).not.toContain("to expand");
	});

	it("prefixes errors, clips long lines and names the spill file", () => {
		const text = rendered(
			resultBlock(theme, row({ isPartial: false, isError: true }), {
				summary: "exit 1",
				body: "z".repeat(300),
				spill: "/tmp/out.txt",
			}),
			60,
		);
		const [summary, line, spill] = text.split("\n");
		// Collapsed, the saved path is behind the expand key; expanded it shows, home- or cwd-relative.
		expect(summary).toBe("  ⎿  Error: exit 1 (ctrl+o to expand)");
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(line.replace(/\u001b\[[0-9;]*m/g, "").endsWith("…")).toBe(true);
		expect(spill).toBeUndefined();
		const open = (spillPath: string, label?: string) =>
			rendered(
				resultBlock(theme, row({ isPartial: false, expanded: true }), {
					summary: "exit 0",
					body: "ok",
					spill: spillPath,
					...(label ? { spillLabel: label } : {}),
				}),
				200,
			)
				.split("\n")
				.at(-1);
		expect(open("/tmp/out.txt")).toBe("     saved: /tmp/out.txt");
		expect(open(path.join(os.homedir(), "x", "out.txt"), "log")).toBe(
			`     log: ~${path.sep}${path.join("x", "out.txt")}`,
		);
		expect(open(path.join(process.cwd(), "out.txt"))).toBe("     saved: out.txt");
	});

	it("strips escape sequences from the body and keeps pre-styled lines as given", () => {
		expect(rendered(resultBlock(theme, row(), { summary: "ok", body: "\u001b[31mred\u001b[0m\n\u202eevil" }))).toBe(
			"  ⎿  ok\n     red\n     evil",
		);
		expect(rendered(resultBlock(theme, row(), { summary: "", lines: ["+ a", "- b"] }))).toBe("  ⎿  + a\n     - b");
	});
});

describe("timed", () => {
	it("leaves results untouched when no pre-run waits were recorded", async () => {
		const plain = { content: [], details: undefined };
		expect(await timed(async () => plain)()).toBe(plain);
		const detailed = { content: [], details: { value: 3 } };
		expect(await timed(async () => detailed)()).toBe(detailed);
	});

	it("lets errors propagate", async () => {
		await expect(timed(async () => Promise.reject(new Error("boom")))()).rejects.toThrow("boom");
	});

	it("adds the check and queue waits recorded for the call id, once", async () => {
		recordCheck("call-wait", 400, Date.now() - 300);
		const run = timed(async (_id: string) => ({ content: [], details: { kept: true } }));
		const first = (await run("call-wait")) as unknown as { details: Record<string, unknown> };
		expect(first.details.checkMs).toBe(400);
		expect(first.details.queuedMs).toBeGreaterThanOrEqual(300);
		expect(first.details.kept).toBe(true);
		expect(first.details).not.toHaveProperty("durationMs");
		const again = (await run("call-wait")) as unknown as { details: Record<string, unknown> };
		expect(again.details.checkMs).toBeUndefined();
		recordCheck("call-fast", 5);
		const fast = (await run("call-fast")) as unknown as { details: Record<string, unknown> };
		expect(fast.details.checkMs).toBeUndefined();
		expect(fast.details.queuedMs).toBeUndefined();
	});
});

describe("resultBlock colouring", () => {
	it("colours only the lines a collapsed preview shows, and counts the hidden rest", () => {
		let painted = 0;
		const counting = {
			...(theme as object),
			fg: (_color: string, text: string) => {
				painted += 1;
				return text;
			},
		} as never;
		const body = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n");
		const text = rendered(resultBlock(counting, row({ isPartial: true }), { summary: "exit 0", body, tail: true }));
		expect(text).toContain("… +995 earlier lines");
		expect(painted).toBeLessThan(10);
		expect(
			rendered(
				resultBlock(theme, row({ isPartial: true }), {
					summary: "exit 0",
					body: "a\nb",
					totalLines: 50,
					tail: true,
				}),
			),
		).toContain("… +48 earlier lines");
	});
});

describe("timingOf", () => {
	it("reads only waits and combines them with Octocode duration in the header", async () => {
		expect(timingOf(undefined)).toEqual({});
		expect(timingOf({ durationMs: 12 })).toEqual({});
		const timing = timingOf({ durationMs: 1200, checkMs: 3400, queuedMs: 150 });
		expect(timing).toEqual({ waits: "checks 3.4s" });
		const context = {
			state: {} as ToolRow,
			isPartial: false,
			executionStarted: true,
			durationMs: 2_500,
			invalidate: vi.fn(),
		};
		resultBlock(theme, context, { summary: "ok", ...timing });
		await Promise.resolve();
		expect(context.invalidate).toHaveBeenCalledOnce();
		resultBlock(theme, context, { summary: "ok", ...timing });
		await Promise.resolve();
		expect(context.invalidate).toHaveBeenCalledOnce();
		const header = rendered(toolHeader(theme, context, "Tool", "x"));
		expect(header).toContain("2.5s");
		expect(header).not.toContain("1.2s");
		expect(header).toContain("checks 3.4s");
		expect(header).not.toContain("queued");
		const slowQueue = { state: {} as ToolRow, isPartial: false, executionStarted: true };
		resultBlock(theme, slowQueue, { summary: "ok", ...timingOf({ durationMs: 10, queuedMs: 2000 }) });
		expect(rendered(toolHeader(theme, slowQueue, "Tool", "x"))).toContain("queued 2s");
	});
});

describe("timedTool", () => {
	it("records the exclusive lock wait without adding an execution duration", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		let entered!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const tool = timedTool(
			{
				name: "t",
				label: "T",
				description: "",
				parameters: {} as never,
				execute: async (id) => {
					if (id === "holder") {
						entered();
						await held;
					}
					return { content: [], details: { id } };
				},
			},
			{ exclusive: true },
		);
		const first = tool.execute("holder", {} as never, undefined, undefined, {} as never);
		await started;
		recordCheck("waiter", 400);
		const second = tool.execute("waiter", {} as never, undefined, undefined, {} as never);
		await vi.advanceTimersByTimeAsync(300);
		release();
		const [, result] = await Promise.all([first, second]);
		expect(result.details).toEqual({ id: "waiter", checkMs: 400, queuedMs: 300 });
	});

	it("is opt-in on timedTool and never sets the batch-wide sequential mode", async () => {
		let running = 0;
		let peak = 0;
		const tool = (exclusiveCalls: boolean) =>
			timedTool(
				{
					name: "t",
					label: "T",
					description: "",
					parameters: {} as never,
					execute: async () => {
						peak = Math.max(peak, ++running);
						await new Promise((resolve) => setTimeout(resolve, 5));
						running -= 1;
						return { content: [], details: {} };
					},
				},
				{ exclusive: exclusiveCalls },
			);
		const serial = tool(true);
		expect(serial.executionMode).toBeUndefined();
		await Promise.all([
			serial.execute("1", {} as never, undefined, undefined, {} as never),
			serial.execute("2", {} as never, undefined, undefined, {} as never),
		]);
		expect(peak).toBe(1);
		const parallel = tool(false);
		await Promise.all([
			parallel.execute("1", {} as never, undefined, undefined, {} as never),
			parallel.execute("2", {} as never, undefined, undefined, {} as never),
		]);
		expect(peak).toBe(2);
	});
});

describe("interrupted rows and expandable prefaces", () => {
	const colored = { ...(theme as object), fg: (color: string, text: string) => `<${color}>${text}` } as never;

	it("draws an Esc abort as an interrupted row with the stopped light, and redraws a header that drew the failed light", async () => {
		const state: ToolRow = {};
		const invalidate = vi.fn();
		const context = { isPartial: false, isError: true, executionStarted: true, state, invalidate };
		expect(rendered(toolHeader(colored, context, "Bash", "sleep 9") as never)).toContain("<error>⊗");
		const body = rendered(resultBlock(colored, context, { summary: "Operation aborted" }));
		expect(body).toContain("<warning>Operation aborted");
		expect(body).not.toContain("Error:");
		await Promise.resolve();
		expect(invalidate).toHaveBeenCalledTimes(1);
		// The stopped light is red like the failed one, with its own glyph ⊘: the row's text says it was interrupted.
		expect(rendered(toolHeader(colored, context, "Bash", "sleep 9") as never)).toContain("<error>⊘");
		// A real failure keeps its Error prefix and the red light.
		const failed = rendered(
			resultBlock(colored, { isPartial: false, isError: true, state: {} }, { summary: "exit 1" }),
		);
		expect(failed).toContain("Error: exit 1");
	});

	it("draws a call whose model response failed as a not-run row with the stopped light, not as a failure", async () => {
		const state: ToolRow = {};
		const context = { isPartial: false, isError: true, executionStarted: true, state, invalidate: vi.fn() };
		const body = rendered(resultBlock(colored, context, { summary: "Not run: the model response failed" }));
		expect(body).toContain("<warning>Not run: the model response failed");
		expect(body).not.toContain("Error:");
		await Promise.resolve();
		expect(rendered(toolHeader(colored, context, "Bash", "ls") as never)).toContain("<error>⊘");
	});

	it("counts a preface apart from hidden body lines and shows it only when expanded", () => {
		const preface = ["Prompt", "line 1", "line 2"];
		const collapsed = rendered(
			resultBlock(
				theme,
				{ isPartial: true, isError: false },
				{ summary: "Done", body: "a\nb", preface, prefaceLabel: "prompt" },
			),
		);
		expect(collapsed).toBe("  ⎿  Done\n     a\n     b\n     … prompt (ctrl+o to expand)");
		const more = rendered(
			resultBlock(
				theme,
				{ isPartial: true, isError: false },
				{ summary: "Done", body: "1\n2\n3\n4\n5\n6\n7", preface, prefaceLabel: "prompt" },
			),
		);
		expect(more).toContain("… +2 lines · prompt (ctrl+o to expand)");
		const open = rendered(
			resultBlock(theme, { isPartial: false, isError: false, expanded: true }, { summary: "Done", body: "a", preface }),
		);
		expect(open).toBe("  ⎿  Done\n     Prompt\n     line 1\n     line 2\n     a");
	});

	it("falls back to Octocode default keys and stops every live row ticker on demand", () => {
		expect(appKey("app.thinking.toggle")).toBe("ctrl+t");
		vi.useFakeTimers();
		try {
			const invalidate = vi.fn();
			toolHeader(theme, { executionStarted: true, isPartial: true, state: {}, invalidate }, "Bash", "x");
			vi.advanceTimersByTime(1_100);
			expect(invalidate).toHaveBeenCalledTimes(1);
			stopRowTimers();
			vi.advanceTimersByTime(5_000);
			expect(invalidate).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("tool row motion", () => {
	beforeEach(() => animationClock.setReducedMotion(false));

	it("holds a running row's light still: nothing repaints at spinner pace, only its one-second elapsed clock", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const context = row({ executionStarted: true });
		expect(rendered(toolHeader(theme, context, "Bash", "ls"))).toBe(`${STILL_RUN} Bash(ls) · 0ms`);
		// The clock runs for the elapsed counter alone.
		expect(animationClock.isRunning()).toBe(true);
		vi.advanceTimersByTime(MOTION.tickMs - MOTION.spinnerMs);
		expect(context.invalidate).not.toHaveBeenCalled();
		expect(rendered(toolHeader(theme, context, "Bash", "ls"))[0]).toBe(STILL_RUN);
		vi.advanceTimersByTime(MOTION.spinnerMs);
		expect(context.invalidate).toHaveBeenCalledTimes(1);
		expect(rendered(toolHeader(theme, context, "Bash", "ls"))).toBe(`${STILL_RUN} Bash(ls) · 1s`);
	});

	it("lets go of the clock the moment a row finishes, and writes nothing while idle", () => {
		vi.useFakeTimers();
		const context = row({ executionStarted: true });
		toolHeader(theme, context, "Bash", "ls");
		vi.advanceTimersByTime(MOTION.spinnerMs);
		const done = { ...context, isPartial: false, durationMs: 1_500 };
		expect(rendered(toolHeader(theme, done, "Bash", "ls"))).toBe("◉ Bash(ls) · 1.5s");
		expect(animationClock.isRunning()).toBe(false);
		const calls = context.invalidate.mock.calls.length;
		vi.advanceTimersByTime(5_000);
		expect(context.invalidate).toHaveBeenCalledTimes(calls);
	});

	it("draws a row first drawn finished (a restored session) or a finished row that still waits without a clock", () => {
		const restored = row({ isPartial: false, durationMs: 1_500 });
		toolHeader(theme, restored, "Read", "a.ts");
		expect(animationClock.isRunning()).toBe(false);
		const blocked = row({ isPartial: false });
		expect(rendered(toolHeader(theme, blocked, "Agent", "x", { state: "waiting" }))).toMatch(/^◐ Agent\(x\)/);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("ticks every running row's elapsed second on its own subscription, lights still, and lets go when they finish", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const older = row({ executionStarted: true });
		const newer = row({ executionStarted: true });
		toolHeader(theme, older, "Bash", "sleep 10");
		toolHeader(theme, newer, "Bash", "seq 1 60");
		const first = rendered(toolHeader(theme, older, "Bash", "sleep 10"))[0];
		expect(first).toBe(STILL_RUN);
		vi.advanceTimersByTime(MOTION.tickMs - MOTION.spinnerMs);
		expect(older.invalidate).not.toHaveBeenCalled();
		expect(newer.invalidate).not.toHaveBeenCalled();
		vi.advanceTimersByTime(MOTION.tickMs * 12 + MOTION.spinnerMs);
		expect(older.invalidate).toHaveBeenCalledTimes(13);
		expect(newer.invalidate).toHaveBeenCalledTimes(13);
		expect(rendered(toolHeader(theme, older, "Bash", "sleep 10"))[0]).toBe(first);
		stopRowTimers();
		expect(animationClock.isRunning()).toBe(false);
	});

	it("holds a waiting row's yellow light still and asks for no frames", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const context = row({ executionStarted: true, toolCallId: "call-wait-bound" });
		expect(rendered(toolHeader(tagged, context, "Bash", "ls"))).toContain("<warning>◐");
		vi.advanceTimersByTime(10_000);
		expect(context.invalidate).not.toHaveBeenCalled();
		expect(rendered(toolHeader(theme, context, "Bash", "ls"))).toBe("◐ Bash(ls) · waiting");
	});

	it("shows a row that waits for its checks or approval as a still yellow light, then the grey running light when its run begins", () => {
		vi.useFakeTimers();
		const context = row({ executionStarted: true, toolCallId: "call-breathe" });
		expect(rendered(toolHeader(tagged, context, "Bash", "ls"))).toContain("<warning>◐");
		void timed(async (_id: string) => ({ content: [] }))("call-breathe");
		// A running tool light is grey and still: the row draws no spinner frame.
		expect(rendered(toolHeader(tagged, context, "Bash", "ls"))).toBe(
			`<muted>${STILL_RUN} <toolTitle>Bash<muted>(<muted>ls<muted>)<dim> · 0ms`,
		);
	});

	it("freezes the spinner in reduced motion, keeping only the one-second elapsed clock", () => {
		vi.useFakeTimers();
		animationClock.setReducedMotion(true);
		const context = row({ executionStarted: true });
		const first = rendered(toolHeader(theme, context, "Bash", "ls"));
		vi.advanceTimersByTime(MOTION.tickMs + 50);
		expect(context.invalidate).toHaveBeenCalledTimes(1);
		expect(rendered(toolHeader(theme, context, "Bash", "ls"))[0]).toBe(first[0]);
	});
});
