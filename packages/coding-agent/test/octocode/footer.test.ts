import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import { chipParts, chipText } from "../../src/octocode/permission/mode.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { liveAgentsOf, publishLiveAgents } from "../../src/octocode/shared/team-spend.ts";
import * as importedModule2 from "../../src/octocode/ui/footer.ts";
import { contextBar, type FooterState, footerLines as paintFooter } from "../../src/octocode/ui/footer.ts";
import { reasoningTwin } from "../../src/octocode/ui/footer/notices.ts";
import * as importedModule1 from "./fake-host.ts";

// The wiring reads the GitHub token through this module: never from the real machine.
const github = vi.hoisted(() => ({ present: true }));
vi.mock("../../src/octocode/ui/footer/github.ts", () => ({
	githubTokenPresent: () => github.present,
	resetGithubToken: () => undefined,
}));

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
/** Records which colour token painted which text. */
const painted: Array<[string, string]> = [];
const recording = {
	fg: (color: string, text: string) => {
		painted.push([color, text]);
		return text;
	},
	bold: (text: string) => text,
} as never;

const state: FooterState = {
	model: "claude-opus-5-5",
	thinking: "high",
	context: { percent: 42, window: 200_000 },
	usage: { input: 12_400, cacheRead: 0, output: 3_100, cost: 0.84, unpriced: false },
	cwd: "/Users/me/code/app",
	home: "/Users/me",
	sessionName: "fix login",
	chip: chipParts("manual"),
};
const statuses = new Map([
	["mcp", "mcp 3/3"],
	["octocode-team", "agents 1/2 ↑1k ↓2k"],
	["octocode-running", "1 bash"],
	["octocode-speed", "58 tok/s"],
	["other-ext", "lint ok"],
]);

/** Statuses as text-only writers set them, in the footer data's shape. */
const footerLines = (
	s: FooterState,
	branch: string | null,
	texts: ReadonlyMap<string, string>,
	paint: never,
	width: number,
) => paintFooter(s, branch, new Map([...texts].map(([key, text]) => [key, { text }])), paint, width);
/** Line 1 as the zones lay it out: the center in the middle of the free space between the outer zones. */
const zones = (left: string, center: string, right: string, width: number) => {
	const free = width - visibleWidth(left) - visibleWidth(center) - visibleWidth(right);
	const gap = Math.floor(free / 2);
	return `${left}${" ".repeat(gap)}${center}${" ".repeat(free - gap)}${right}`;
};
/** A two-zone line: the left at column 0, the right ending at the last column. */
const ends = (left: string, right: string, width: number) =>
	`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

describe("footer", () => {
	it("shows the prompt-cache hit rate in the health zone once a cache read is reported, and keeps it after the tokens leave", () => {
		const cached = { ...state, usage: { ...state.usage, input: 40_000, cacheRead: 30_000 } };
		const [top, bottom] = footerLines(cached, "main", new Map(), theme, 200);
		// One cache figure: the share, never the cache reads as a count beside it.
		expect(top).toContain("ctx ▰▰▰▱▱▱▱▱ 42% of 200k · 13.1k tok (↑10k ↓3.1k) · 75% cached");
		expect(top.match(/cache/g)).toHaveLength(1);
		expect(bottom).not.toContain("cache");
		// No cache reads (a model without prompt caching): no permanent `0% cached`.
		expect(footerLines(state, "main", new Map(), theme, 200).join("\n")).not.toContain("cache");
		// Narrow, the tokens give way before the cached share.
		const [narrow] = footerLines(cached, "main", new Map(), theme, 60);
		expect(narrow).toBe(zones("~/code/app ⎇ main · ⏸ manual", "ctx 42% · 75% cached", "Σ ≈$0.84", 60));
	});

	it("places a pending retry beside the total on line 1 and timer judging spend in line 2's details, neither as an other status", () => {
		const own = new Map([
			[STATUS.wakeRetry, "retrying in 8s"],
			[STATUS.timers, "timer judging $0.004"],
		]);
		const [top, bottom] = footerLines(state, "main", own, theme, 220);
		expect(top).toMatch(/ retrying in 8s · Σ ≈\$0\.84$/);
		expect(bottom).toMatch(/ timer judging \$0\.004 · \/providers · \/model · \/resume$/);
		expect(top).not.toContain("timer judging");
		expect(bottom).not.toContain("retrying");
	});

	it("shows environment, health and totals on line 1, and model:effort with the details on line 2", () => {
		const [top, bottom] = footerLines(state, "main", statuses, theme, 170);
		expect(top).toBe(
			zones(
				"~/code/app ⎇ main · ⏸ permission: manual · shift+tab",
				"ctx ▰▰▰▱▱▱▱▱ 42% of 200k · 15.5k tok (↑12.4k ↓3.1k)",
				"1 bash · agents 1/2 ↑1k ↓2k · Σ ≈$0.84",
				170,
			),
		);
		// The command hints close the line while it has room.
		expect(bottom).toBe(
			ends("claude-opus-5-5:high · fix login", "58 tok/s · mcp 3/3 · lint ok · /providers · /model · /resume", 170),
		);
	});

	it("names the provider's kind beside the model, writes plan-billed replies as a plan estimate, and drops the kind right after the hints", () => {
		const sub: FooterState = { ...state, kind: "subscription", planBilled: { replies: 1, cost: 0.84 } };
		const [top, wide] = footerLines(sub, "main", statuses, theme, 200);
		expect(wide).toMatch(/^claude-opus-5-5:high · subscription · fix login /);
		expect(top).toMatch(/ Σ ~\$0\.84 plan$/);
		const rows = Array.from({ length: 160 }, (_, i) => footerLines(sub, "main", statuses, theme, 200 - i)[1]);
		// Only the hints leave before the kind; the speed and the session name outlast it.
		expect(rows.filter((row) => row.includes("/providers") && !row.includes("subscription"))).toHaveLength(0);
		expect(
			rows.some((row) => !row.includes("subscription") && row.includes("58 tok/s") && row.includes("fix login")),
		).toBe(true);
	});

	it("colours context by how full it is", () => {
		expect(contextBar(30)).toEqual({ bar: "▰▰▱▱▱▱▱▱", color: "success" });
		// Any use shows: 3% is not an empty gauge.
		expect(contextBar(3).bar).toBe("▰▱▱▱▱▱▱▱");
		expect(contextBar(0).bar).toBe("▱▱▱▱▱▱▱▱");
		expect(contextBar(100).bar).toBe("▰▰▰▰▰▰▰▰");
		expect(contextBar(65).color).toBe("warning");
		expect(contextBar(91).color).toBe("error");
		// Colour and fill follow the rounded percent the label shows.
		expect(contextBar(49.6)).toEqual({ bar: "▰▰▰▰▱▱▱▱", color: "warning" });
		expect(contextBar(49.4).color).toBe("success");
		expect(contextBar(80.4).color).toBe("warning");
		expect(contextBar(80.6).color).toBe("error");
		// The alarm point moves with the auto-compact point (a percent of the window).
		expect(contextBar(70, 68).color).toBe("error");
		expect(contextBar(60, 68).color).toBe("warning");
		painted.length = 0;
		footerLines({ ...state, context: { percent: 91, window: 200_000 } }, "main", statuses, recording, 160);
		expect(painted.some(([color, text]) => color === "error" && text.includes("91%"))).toBe(true);
	});

	it("shows the last run's speed only between runs", () => {
		expect(footerLines(state, "main", statuses, theme, 200)[1]).toContain("58 tok/s");
		expect(footerLines({ ...state, running: true }, "main", statuses, theme, 200).join("\n")).not.toContain("tok/s");
	});

	it("draws a session name without its escape sequences", () => {
		const [, bottom] = footerLines(
			{ ...state, sessionName: "fix \u001b]0;pwned\u0007login\u001b[2J" },
			null,
			new Map(),
			theme,
			160,
		);
		expect(bottom).toContain("fix login");
		expect(bottom).not.toContain("\u001b");
	});

	it("keeps another extension's multi-line status on one row, as Octocode's own footer does", () => {
		const [, bottom] = footerLines(state, null, new Map([["mcp", "MCP:\n 3 servers\t ok"]]), theme, 160);
		expect(bottom).toContain("MCP: 3 servers ok");
		expect(bottom).not.toMatch(/[\r\n\t]/);
	});

	it("draws native and extension statuses with their colours but without other terminal controls", () => {
		const hostile = "\u001b]0;pwned\u0007\u001b]8;;https://x.test\u0007";
		const [top, bottom] = footerLines(
			state,
			null,
			new Map([
				[STATUS.running, `${hostile}2 sub\u202eagents\u001b[2J`],
				[STATUS.queued, `\u001b[31m✉ 1 queued\u001b[39m\r${hostile}`],
				["other-ext", `\u001b[32mlint ok\u001b[39m${hostile}\u2028done`],
			]),
			theme,
			240,
		);
		expect(top).toContain("2 subagents");
		expect(top).toContain("\u001b[31m✉ 1 queued\u001b[39m");
		expect(bottom).toContain("\u001b[32mlint ok\u001b[39m done");
		for (const line of [top, bottom]) {
			expect(line).not.toMatch(/\u001b\]|\u0007|\u001b\[2J|\u202e|[\r\n\u2028]/);
		}
	});

	it("keeps raw model, directory, branch and session text on their own rows", () => {
		const dirty = (value: string) => `${value}\nnext\tpart\u2028last\u001b[2J`;
		const lines = footerLines(
			{
				...state,
				model: dirty("model"),
				cwd: dirty("/work/app"),
				thinking: dirty("high"),
				sessionName: dirty("session"),
			},
			dirty("main"),
			new Map(),
			theme,
			400,
		);
		expect(lines[1]).toContain("model next part last:high next part last");
		expect(lines[0]).toContain("/work/app next part last");
		expect(lines[1]).toContain("session next part last");
		for (const line of lines) expect(line).not.toMatch(/[\r\n\t\u2028\u2029\u001b]/);
	});

	it("reserves the permission mode when model names and running-work statuses exceed the row", () => {
		const long = { ...state, model: "provider/".repeat(40) };
		const busy = new Map([...statuses, ["octocode-team", "agents ".repeat(40)]]);
		const [normal] = footerLines(long, null, statuses, theme, 170);
		// The footer is the one home of the mode: its full chip names the shortcut while there is room.
		expect(normal).toContain("permission: manual · shift+tab");
		for (const width of [75, 40, 26, 20, 10]) {
			const lines = footerLines(long, null, busy, theme, width);
			expect(lines[0], `mode at ${width} columns`).toContain("manual");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		for (const width of [0, 1, 4, 8]) {
			expect(footerLines(long, null, busy, theme, width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("says so when context is unknown (right after compaction) and hides empty parts", () => {
		const [top, bottom] = footerLines(
			{
				...state,
				thinking: undefined,
				context: { percent: null, window: 200_000 },
				usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
				sessionName: undefined,
				chip: undefined,
			},
			null,
			new Map(),
			theme,
			120,
		);
		// Nothing spent and no compaction yet: no zero counters, no `Σ`; the center ends the line.
		expect(top).toBe(`~/code/app${" ".repeat(48)}ctx ? of 200k`);
		expect(bottom).toBe(ends("claude-opus-5-5", "/providers · /model · /resume", 120));
		expect(
			footerLines(
				{
					...state,
					usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
					sessionName: undefined,
					chip: undefined,
					context: undefined,
				},
				null,
				new Map(),
				theme,
				25,
			),
		).toEqual(["~/code/app", "claude-opus-5-5:high"]);
	});

	it("shows `ctx ?` for a model with no known window instead of hiding the gauge", () => {
		const [top] = footerLines(
			{
				...state,
				thinking: undefined,
				context: { percent: null, window: 0 },
				usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
				sessionName: undefined,
				chip: undefined,
			},
			null,
			new Map(),
			theme,
			120,
		);
		expect(top).toBe(`~/code/app${" ".repeat(52)}ctx ?`);
	});

	it("drops the least important parts first on narrow terminals, never the model, context, permission mode, running work or Σ", () => {
		const [top, bottom] = footerLines(
			state,
			"feature/a-very-long-branch-name-for-testing",
			new Map([...statuses, ["other-ext", "lint ok · 12 warnings in 4 files"]]),
			theme,
			75,
		);
		// The routine team count, the tokens and the long status give way; the branch keeps a third of the row.
		expect(top).toBe(zones("app ⎇ feature/a-very-long-bran… · ⏸ manual", "ctx 42%", "1 bash · Σ ≈$0.84", 75));
		expect(bottom).toBe(ends("claude-opus-5-5:high · fix login", "58 tok/s · mcp 3/3 · … /status", 75));
		// At 40 columns the mode chip is still there, in its short form (just the mode).
		const [narrow] = footerLines(
			{ ...state, context: undefined, chip: chipParts("full") },
			"main",
			new Map(),
			theme,
			40,
		);
		expect(narrow).toBe(ends("~/code/app ⎇ main · ⏵⏵ full", "Σ ≈$0.84", 40));
		const [squeezed] = footerLines({ ...state, context: undefined, thinking: undefined }, "main", new Map(), theme, 26);
		// The location gives way first: its bare form drops the branch whole, before the mode and the total.
		expect(squeezed.replaceAll("\u001b[0m", "")).toBe("app · ⏸ manual    Σ ≈$0.84");
		const tiny = footerLines(state, "main", statuses, theme, 20);
		expect(tiny.every((line) => visibleWidth(line) <= 20)).toBe(true);
	});
});

describe("footer line 1 work statuses", () => {
	it("keeps queued messages and the typed running-work counts on line 1 when other parts drop", () => {
		const work = new Map([...statuses, [STATUS.queued, "✉ 2 queued"], [STATUS.running, "2 agents · 1 bash · 1 timer"]]);
		const [wide, bottom] = footerLines(state, "main", work, theme, 200);
		expect(wide).toContain("2 agents · 1 bash · 1 timer");
		expect(wide).toContain("✉ 2 queued");
		expect(bottom).not.toContain("queued");
		// 110, not 90: context and thinking now outrank the queued counter, which needs the extra cells (footer audit F2).
		const [narrow] = footerLines(state, "main", work, theme, 110);
		expect(narrow).toContain("✉ 2 queued");
		expect(narrow).not.toContain("tok/s");
	});

	it('places the hooks status on line 1 and the backlog counts on line 2, neither as an "other" status', () => {
		const own = new Map([
			[STATUS.hooks, "hook 3s"],
			[STATUS.backlog, "2 ongoing · /backlog"],
		]);
		const [top, bottom] = footerLines(state, "main", own, theme, 200);
		expect(top).toContain("hook 3s");
		expect(bottom).not.toContain("hook 3s");
		expect(bottom).toContain("2 ongoing · /backlog");
		expect(top).not.toContain("2 ongoing");
		expect(bottom.match(/2 ongoing/g)).toHaveLength(1);
	});

	it("paints each status in its tone with the theme of the frame, and a tone-less status as written", () => {
		const frame = { fg: (color: string, text: string) => `[${color}]${text}`, bold: (text: string) => text } as never;
		const [top, bottom] = paintFooter(
			state,
			null,
			new Map([
				[STATUS.queued, { text: "✉ 1 queued", tone: "accent" as const }],
				["lint-ext", { text: "lint failed", tone: "error" as const }],
				["other-ext", { text: "lint ok" }],
			]),
			frame,
			200,
		);
		expect(top).toContain("[accent]✉ 1 queued");
		expect(bottom).toContain("[error]lint failed");
		expect(bottom).toContain("lint ok");
		expect(bottom).not.toContain("]lint ok");
	});

	it("gives a long branch a third of the row", () => {
		const branch = `feature/${"x".repeat(80)}`;
		expect(footerLines(state, branch, new Map(), theme, 240)[0]).toContain(`~/code/app ⎇ ${branch.slice(0, 79)}… · ⏸`);
	});
});

describe("footer under a busy status row", () => {
	const busy = new Map([
		["octocode-team", "agents 3/6 ↑12k ↓34k"],
		["octocode-running", "3 agents · 2 bash · 1 timer"],
		["octocode-queued", "✉ 2 queued"],
		["octocode-hooks", "hook running 12s"],
	]);
	it("keeps the context percentage on line 1 and the thinking level on line 2 ahead of ephemeral status counters at 80 and 120 columns", () => {
		for (const width of [80, 120]) {
			const lines = footerLines({ ...state, thinking: "medium", running: true }, "main", busy, theme, width);
			expect(lines[0], `ctx at ${width}`).toContain("ctx ▰▰▰▱▱▱▱▱ 42%");
			expect(lines[0], `running work at ${width}`).toContain("3 agents · ✉ 2 queued · Σ ≈$0.84");
			expect(lines[0], `hook clock at ${width}`).not.toContain("hook running");
			expect(lines[1], `thinking at ${width}`).toMatch(/^claude-opus-5-5:medium · fix login /);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

describe("footer bottom line: team totals, GitHub token, hints", () => {
	const HINTS = "/providers · /model · /resume";
	const bare: FooterState = { ...state, sessionName: undefined, chip: undefined };

	it("shows one total cost: the session ledger plus live agents that have not reported, each counted once", () => {
		const live = [
			{ id: "a-0001", parentId: "main", cost: 1, unpriced: false },
			{ id: "b-0002", parentId: "a-0001", cost: 0.5, unpriced: false },
		];
		const usage = { ...bare.usage, cost: 0.84 };
		const money = (s: FooterState) =>
			footerLines(s, "main", new Map(), theme, 200)
				.join("\n")
				.match(/[Σ≈]\S*.*?\$[\d.]+/g);
		// Two live agents add to the ledger: 0.84 + 1 + 0.5.
		expect(money({ ...bare, usage, live })).toEqual(["Σ ≈$2.34"]);
		// a-0001 reported: its result holds its spend and its child's, which the ledger now has (0.84 + 1.5).
		const after = { ...bare, usage: { ...usage, cost: 2.34 }, live, reported: new Set(["a-0001"]) };
		expect(money(after)).toEqual(["Σ ≈$2.34"]);
		// No team status adds a second figure.
		expect(money({ ...after, live: [] })).toEqual(["Σ ≈$2.34"]);
	});

	it("ends with the command hints, and drops them before anything else when the line is narrow", () => {
		const wide = footerLines(bare, "main", new Map(), theme, 200)[1];
		expect(wide).toBe(ends("claude-opus-5-5:high", HINTS, 200));
		// Line 2 at every width: while the hints show, every other detail and the session name show too.
		const named = { ...bare, sessionName: "fix login", githubToken: true };
		const rows = Array.from({ length: 170 }, (_, i) => footerLines(named, "main", statuses, theme, 200 - i)[1]);
		expect(rows[0].endsWith(`58 tok/s · mcp 3/3 · lint ok · ${HINTS}`)).toBe(true);
		const withHints = rows.filter((row) => row.includes("/providers"));
		expect(withHints.length).toBeGreaterThan(0);
		expect(withHints.length).toBeLessThan(rows.length);
		for (const row of withHints)
			for (const part of ["fix login", "✓ GitHub", "58 tok/s", "mcp 3/3", "lint ok"]) expect(row).toContain(part);
	});

	it("marks the GitHub token with a glyph and a word: ✓ present, ✗ missing, nothing when unknown", () => {
		const line = (githubToken: boolean | undefined, width = 200) =>
			footerLines({ ...bare, githubToken }, "main", new Map(), theme, width)[1];
		expect(line(true)).toContain("✓ GitHub");
		expect(line(true)).not.toContain("GitHub token");
		expect(line(false)).toContain("✗ GitHub token");
		expect(line(undefined)).not.toContain("GitHub");
		// A missing token outlives the hints; narrow, it shortens to `✗ GitHub` before it goes.
		const rows = Array.from({ length: 120 }, (_, i) => line(false, 120 - i));
		const shortened = rows.filter((row) => row.includes("✗ GitHub") && !row.includes("GitHub token"));
		expect(shortened.length).toBeGreaterThan(0);
		// The hints give way before the mark does.
		expect(rows.filter((row) => row.includes("/providers") && !row.includes("✗ GitHub")).length).toBe(0);
		const painted: string[] = [];
		const recorder = {
			fg: (color: string, text: string) => {
				painted.push(`${color}:${text}`);
				return text;
			},
			bold: (text: string) => text,
		} as never;
		footerLines({ ...bare, githubToken: true }, "main", new Map(), recorder, 200);
		footerLines({ ...bare, githubToken: false }, "main", new Map(), recorder, 200);
		expect(painted).toContain("success:✓ GitHub");
		expect(painted).toContain("error:✗ GitHub token");
	});
});

describe("footer wiring", () => {
	it.each([
		["session context-window override", 60_000, 30_000, "60k"],
		["physical route with a different window", 120_000, 60_000, "120k"],
	] as const)("uses the effective window for a %s", async (_reason, window, tokens, limit) => {
		const fake = importedModule1.fakeHost();
		importedModule2.registerFooter(fake.api);
		const ctx = importedModule1.fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		ctx.model = { provider: "test", id: "selected", reasoning: false, contextWindow: 100_000 };
		ctx.getContextUsage = () => ({ tokens, contextWindow: window, percent: (tokens / window) * 100 });
		await fake.emit("session_start", {}, ctx);
		const component = ctx.ui.footer({ requestRender: vi.fn() }, theme, {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
		});
		try {
			expect(component.render(160)[0]).toContain(`ctx ▰▰▰▰▱▱▱▱ 50% of ${limit}`);
		} finally {
			component.dispose();
		}
	});

	it("gauges the window and takes the alarm point from the core threshold, not the selected model's thinking reserve", async () => {
		const fake = importedModule1.fakeHost();
		importedModule2.registerFooter(fake.api);
		const ctx = importedModule1.fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		ctx.model = { provider: "router", id: "auto", reasoning: false, contextWindow: 120_000 };
		ctx.getContextUsage = () => ({
			tokens: 75_000,
			contextWindow: 120_000,
			percent: 62.5,
			compactionThreshold: 100_000,
		});
		await fake.emit("session_start", {}, ctx);
		const component = ctx.ui.footer({ requestRender: vi.fn() }, theme, {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
		});
		try {
			expect(component.render(160)[0]).toContain("ctx ▰▰▰▰▰▱▱▱ 63% of 120k");
		} finally {
			component.dispose();
		}
	});

	it("shows the new limit after session_context_changed", async () => {
		const fake = importedModule1.fakeHost();
		importedModule2.registerFooter(fake.api);
		const ctx = importedModule1.fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		let window = 200_000;
		ctx.model = { provider: "test", id: "selected", reasoning: false, contextWindow: 200_000 };
		ctx.getContextUsage = () => ({ tokens: 20_000, contextWindow: window, percent: (20_000 / window) * 100 });
		await fake.emit("session_start", {}, ctx);
		const component = ctx.ui.footer({ requestRender: vi.fn() }, theme, {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
		});
		try {
			expect(component.render(160)[0]).toContain("10% of 200k");
			window = 50_000;
			await fake.emit("session_context_changed", { type: "session_context_changed" }, ctx);
			expect(component.render(160)[0]).toContain("40% of 50k");
		} finally {
			component.dispose();
		}
	});

	it("replaces Octocode's footer, sums the session usage and samples context on events", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api.models as { getThinkingLevel: () => string }).getThinkingLevel = () => "medium";
		// No compaction reserve: the gauge reads against the whole window.
		(fake.api.settings as { get: () => unknown }).get = () => ({ compaction: { reserveTokens: 0 } });
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		let percent = 10;
		ctx.model = { id: "model-x", reasoning: true, contextWindow: 100_000 };
		ctx.getContextUsage = () => ({ tokens: percent * 1000, contextWindow: 100_000, percent });
		ctx.sessionManager.getEntries = () => [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1_000, cacheRead: 3_000, output: 200, cost: { total: 0.1 } },
				},
			},
			{ type: "message", message: { role: "toolResult", usage: { input: 500, output: 50, cost: { total: 0.05 } } } },
			{ type: "message", message: { role: "user" } },
		];
		await fake.emit("session_start", {}, ctx);
		let renders = 0;
		const data = {
			getGitBranch: () => "main",
			getFeatureStatuses: () => new Map([["mcp", "mcp 1/1"]]),
			onBranchChange: () => () => undefined,
		};
		const component = ctx.ui.footer(
			{
				requestRender: () => {
					renders += 1;
					return renders;
				},
			},
			theme,
			data,
		);
		github.present = true;
		const [initialTop, bottom] = component.render(120) as string[];
		// ↑ is the new prompt tokens (uncached and cache writes); cache reads show only as the share of the whole prompt: 3k of 4.5k.
		expect(initialTop).toBe(
			zones("/work/app ⎇ main", "ctx ▰▱▱▱▱▱▱▱ 10% of 100k · 1.8k tok (↑1.5k ↓250) · 67% cached", "Σ ≈$0.15", 120),
		);
		// The session's activity light leads the model (contract change: status dots, wave C): idle with no port, light alone.
		// Idle draws its own glyph, ○: ⏺ means running only.
		expect(bottom).toBe(ends("○ model-x:medium · API key", "✓ GitHub · mcp 1/1 · /providers · /model · /resume", 120));
		percent = 64;
		await fake.emit(
			"message_end",
			{ message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.01 } } } },
			ctx,
		);
		expect(renders).toBe(1);
		const [top] = component.render(120) as string[];
		// 64k of the 100k window, whatever the compaction reserve.
		expect(top).toContain("64%");
		expect(top).toContain("≈$0.16");
		// A rename (/name, or the automatic title) shows at once.
		const name = "auth flow";
		ctx.sessionManager.getSessionName = () => name;
		await fake.emit("session_info_changed", { type: "session_info_changed", name }, ctx);
		expect(renders).toBe(2);
		expect((component.render(120) as string[]).join("\n")).toContain("auth flow");
		component.dispose();
		await fake.emit("agent_end", {}, ctx);
		expect(renders).toBe(2);
	});

	it("shows the model's provider's plan window from 70 %, red from 90 %, and nothing below (RFC V5)", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		const now = Date.now();
		let used = 0.91;
		const asked: string[] = [];
		const reading = (usedFraction: number, kind: "plan" | "rate" = "plan") => ({
			provider: "openai-codex",
			window: kind === "plan" ? "primary" : "requests",
			label: kind === "plan" ? "5h" : "requests",
			usedFraction,
			resetsAt: now + 3_600_000,
			kind,
			source: "header" as const,
			observedAt: now,
		});
		registerFooter(fake.api, {
			current: (provider: string) => (asked.push(provider), [reading(0.99, "rate"), reading(used)]),
		});
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		ctx.model = { provider: "openai-codex", id: "gpt-5", contextWindow: 100_000 };
		await fake.emit("session_start", {}, ctx);
		const data = {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		};
		painted.length = 0;
		const component = ctx.ui.footer({ requestRender: () => 0 }, recording, data);
		expect(asked).toContain("openai-codex");
		// A rate limit refills within a minute and never shows; the plan window does, with its reset.
		expect(component.render(160)[0]).toMatch(/quota 5h 91% · resets \d\d:\d\d$/);
		expect(painted).toContainEqual(["error", "quota 5h 91%"]);
		used = 0.75;
		await fake.emit("model_select", {}, ctx);
		painted.length = 0;
		expect(component.render(160)[0]).toContain("quota 5h 75%");
		expect(painted).toContainEqual(["warning", "quota 5h 75%"]);
		used = 0.4;
		await fake.emit("model_select", {}, ctx);
		expect(component.render(160).join("\n")).not.toContain("quota");
		component.dispose();
	});

	it("rebuilds the footer only when an input changed, samples context on replies and tree moves, not on tool results", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api.models as { getThinkingLevel: () => string }).getThinkingLevel = () => "medium";
		// No compaction reserve: the gauge reads against the whole window.
		(fake.api.settings as { get: () => unknown }).get = () => ({ compaction: { reserveTokens: 0 } });
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		let percent = 10;
		let samples = 0;
		ctx.model = { id: "model-x", reasoning: false, contextWindow: 100_000 };
		ctx.getContextUsage = () => {
			samples += 1;
			return { tokens: percent * 1000, contextWindow: 100_000, percent };
		};
		ctx.sessionManager.getEntries = () => [];
		await fake.emit("session_start", {}, ctx);
		let statuses = new Map([["mcp", "mcp 1/1"]]);
		const data = {
			getGitBranch: () => "main",
			getFeatureStatuses: () => statuses,
			onBranchChange: () => () => undefined,
		};
		const component = ctx.ui.footer({ requestRender: () => undefined }, theme, data);
		const first = component.render(120);
		// Every streamed token repaints the footer: unchanged inputs reuse the lines.
		expect(component.render(120)).toBe(first);
		expect(component.render(100)).not.toBe(first);
		statuses = new Map([["mcp", "mcp 2/2"]]);
		expect((component.render(120) as string[]).join("\n")).toContain("mcp 2/2");
		const counted = samples;
		// A subagent's tool result adds its cost without walking the session for context usage.
		await fake.emit(
			"message_end",
			{ message: { role: "toolResult", usage: { input: 10, output: 1, cost: { total: 0.02 } } } },
			ctx,
		);
		expect(samples).toBe(counted);
		expect((component.render(120) as string[])[0]).toContain("≈$0.02");
		expect((component.render(120) as string[])[0]).not.toContain("n/a");
		// A subagent that ran partly on a model without pricing (priced cost > 0) still marks the total.
		await fake.emit(
			"message_end",
			{
				message: {
					role: "toolResult",
					usage: { input: 10, output: 1, cost: { total: 0.02 } },
					details: { unpriced: true },
				},
			},
			ctx,
		);
		expect((component.render(120) as string[])[0]).toContain("≈$0.04 + n/a");
		await fake.emit("message_end", { message: { role: "user" } }, ctx);
		expect(samples).toBe(counted);
		// Moving in the session tree (/tree) changes the context: sampled again.
		percent = 42;
		await fake.emit("session_tree", {}, ctx);
		expect(samples).toBe(counted + 1);
		expect((component.render(120) as string[])[0]).toContain("42%");
		component.invalidate();
		expect(component.render(120)).not.toBe(first);
	});

	it("reads the gauge against the window, not the compaction point, and counts background subagent reports in the cost", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api.models as { getThinkingLevel: () => string }).getThinkingLevel = () => "off";
		// A 1M window uses the built-in reserve even if legacy overrides remain on disk.
		(fake.api.settings as { get: () => unknown }).get = () => ({
			compaction: { reserveTokens: 40_000, modelOverrides: { "gw/big": { reserveTokens: 800_000 } } },
		});
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		ctx.model = { provider: "gw", id: "big", reasoning: false, contextWindow: 1_000_000 };
		ctx.getContextUsage = () => ({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 });
		// A background report saved in the session (a custom_message entry) counts, as one that arrives later does.
		const report = (cost: number) => ({
			usage: { input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 100, cost: { total: cost } },
			unpriced: false,
		});
		ctx.sessionManager.getEntries = () => [
			{ type: "custom_message", customType: "octocode-agent-result", details: report(1.5) },
		];
		await fake.emit("session_start", {}, ctx);
		const data = {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		};
		const component = ctx.ui.footer({ requestRender: () => undefined }, theme, data);
		let [top] = component.render(120) as string[];
		expect(top).toContain("15% of 1M");
		expect(top).toContain("≈$1.50");
		expect(top).toContain("1.1k tok (↑1k ↓100) · 90% cached");
		await fake.emit(
			"message_end",
			{ message: { role: "custom", customType: "octocode-agent-result", details: report(0.5) } },
			ctx,
		);
		// A custom message without usage (a team message) adds nothing.
		await fake.emit(
			"message_end",
			{ message: { role: "custom", customType: "octocode-agent-message", details: { id: "x" } } },
			ctx,
		);
		[top] = component.render(120) as string[];
		expect(top).toContain("≈$2.00");
		expect(top).toContain("2.2k tok (↑2k ↓200) · 90% cached");
	});

	it("adds a live agent to Σ until its report reaches the ledger, then counts it once", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		ctx.sessionManager.getEntries = () => [];
		await fake.emit("session_start", {}, ctx);
		const data = {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		};
		const component = ctx.ui.footer({ requestRender: () => undefined }, theme, data);
		const money = () => (component.render(160) as string[]).join("\n").match(/Σ ≈\$[\d.]+/g);
		await fake.emit(
			"message_end",
			{ message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.25 } } } },
			ctx,
		);
		try {
			publishLiveAgents(liveAgentsOf(fake.api), [{ id: "sly-crab", parentId: "me", cost: 1, unpriced: false }]);
			expect(money()).toEqual(["Σ ≈$1.25"]);
			// The report arrives while the panel still lists the child: its spend moves to the ledger, not counted twice.
			const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } };
			await fake.emit(
				"message_end",
				{ message: { role: "custom", customType: "octocode-agent-result", details: { id: "sly-crab", usage } } },
				ctx,
			);
			expect(money()).toEqual(["Σ ≈$1.25"]);
			publishLiveAgents(liveAgentsOf(fake.api), []);
			expect(money()).toEqual(["Σ ≈$1.25"]);
		} finally {
			publishLiveAgents(liveAgentsOf(fake.api), []);
		}
	});

	it("marks usage from a model without pricing instead of counting it as free, and says so once", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api.models as { getThinkingLevel: () => string }).getThinkingLevel = () => "off";
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		const rates = (rate: number) => ({ cost: { input: rate, output: rate, cacheRead: rate, cacheWrite: rate } });
		ctx.modelRegistry = {
			// Who paid is read through `entryBilling`, from each provider's billing, as on `/web` and for `maxCost`.
			getProviderBilling: () => "metered",
			getProviderKind: () => "local",
			find: (provider: string) => (provider === "local" ? rates(0) : rates(3)),
		};
		ctx.model = { id: "llama", reasoning: false, contextWindow: 100_000 };
		ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 });
		await fake.emit("session_start", {}, ctx);
		const data = {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		};
		const component = ctx.ui.footer({ requestRender: () => undefined }, theme, data);
		const free = {
			role: "assistant",
			provider: "local",
			model: "llama",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		};
		await fake.emit("message_end", { message: free }, ctx);
		expect((component.render(120) as string[])[0]).toMatch(/ +cost n\/a$/);
		await fake.emit(
			"message_end",
			{
				message: { ...free, provider: "anthropic", model: "opus", usage: { ...free.usage, cost: { total: 2.28 } } },
			},
			ctx,
		);
		expect((component.render(120) as string[])[0]).toMatch(/ +≈\$2\.28 \+ n\/a$/);
		await fake.emit("message_end", { message: free }, ctx);
		expect(ctx.ui.notes).toEqual([
			{ message: "local/llama has no pricing in models.json; its usage is not in the cost", type: "warning" },
		]);
		// A new session warns again.
		await fake.emit("session_start", {}, ctx);
		await fake.emit("message_end", { message: free }, ctx);
		expect(ctx.ui.notes).toHaveLength(2);
	});

	it("says once when the model leaves out the reasoning its built-in twin declares", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const builtIn = {
			provider: "anthropic",
			id: "claude-opus-5-5",
			reasoning: true,
			compat: { forceAdaptiveThinking: true },
		};
		const copy = { provider: "proxy", id: "claude-opus-5-5", reasoning: undefined, compat: {} };
		expect(reasoningTwin(copy as never, [copy, builtIn] as never)).toBe(builtIn);
		expect(reasoningTwin(builtIn as never, [copy, builtIn] as never)).toBeUndefined();
		expect(reasoningTwin({ ...copy, id: "llama" } as never, [copy, builtIn] as never)).toBeUndefined();
		const fake = fakeHost();
		(fake.api.models as { getThinkingLevel: () => string }).getThinkingLevel = () => "off";
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		ctx.modelRegistry = {
			billedBySubscription: () => false,
			getProviderKind: () => "API key",
			getAll: () => [copy, builtIn],
			find: () => undefined,
		};
		ctx.model = { ...copy, contextWindow: 200_000 };
		ctx.getContextUsage = () => undefined;
		await fake.emit("session_start", {}, ctx);
		await fake.emit("model_select", {}, ctx);
		expect(ctx.ui.notes).toEqual([
			{
				message:
					'proxy/claude-opus-5-5 does not declare reasoning in models.json, so Octocode never asks it to think. anthropic/claude-opus-5-5 declares it: add "reasoning": true and "compat": { "forceAdaptiveThinking": true } to its entry.',
				type: "warning",
			},
		]);
	});

	it("counts what full ran beside the total, and drops the count before the mode", () => {
		expect(chipText("full")).toBe("⏵⏵ permission: full · shift+tab");
		expect(chipText("full", { actions: 0, warnings: 0 })).toBe("⏵⏵ permission: full · shift+tab");
		expect(chipText("full", { actions: 1, warnings: 0 })).toBe("⏵⏵ permission: full · 1 action · shift+tab");
		expect(chipText("full", { actions: 12, warnings: 2 })).toBe("⏵⏵ permission: full · 12 actions · 2 ⚠ · shift+tab");
		expect(chipText("workspace", { actions: 12, warnings: 2 })).toBe("permission: workspace · shift+tab");
		const chip = chipParts("full", { actions: 12, warnings: 2 });
		const [wide] = footerLines({ ...state, context: undefined, chip }, "main", new Map(), theme, 200);
		expect(wide).toMatch(/^~\/code\/app ⎇ main · ⏵⏵ permission: full · shift\+tab .* 12 actions · 2 ⚠ · Σ ≈\$0\.84$/);
		const [narrow] = footerLines({ ...state, context: undefined, chip }, "main", new Map(), theme, 44);
		expect(narrow).toBe(ends("~/code/app ⎇ main · ⏵⏵ full", "Σ ≈$0.84", 44));
	});
});

describe("summary usage", () => {
	const usage = (input: number, output: number, total: number) => ({ input, output, cacheRead: 0, cost: { total } });
	it("counts compaction and branch summary spend on replay and as they happen", async () => {
		const fake = importedModule1.fakeHost();
		const ctx = importedModule1.fakeCtx({ cwd: "/work/app" }) as any;
		ctx.sessionManager.getEntries = () => [
			{ type: "message", message: { role: "assistant", usage: usage(1_000, 100, 0.1) } },
			{ type: "compaction", usage: usage(2_000, 200, 0.2) },
			{ type: "branch_summary", usage: usage(500, 50, 0.05) },
			{ type: "compaction" },
		];
		importedModule2.registerFooter(fake.api);
		await fake.emit("session_start", {}, ctx);
		const component = ctx.ui.footer({ requestRender: vi.fn() }, theme, {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => {},
		});
		const rendered = () => component.render(200).join("\n");
		expect(rendered()).toContain("3.9k tok (");
		expect(rendered()).toContain("≈$0.35");
		await fake.emit("session_compact", { compactionEntry: { type: "compaction", usage: usage(1_000, 100, 0.1) } }, ctx);
		expect(rendered()).toContain(" 5k tok (");
		expect(rendered()).toContain("≈$0.45");
		await fake.emit("session_tree", { summaryEntry: { type: "branch_summary", usage: usage(100, 10, 0.01) } }, ctx);
		expect(rendered()).toContain("≈$0.46");
	});
});

describe("run metrics", () => {
	it("counts compactions and leaves the run's time to the transcript's turn line", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const fake = importedModule1.fakeHost();
			const ctx = importedModule1.fakeCtx({ cwd: "/work/app" }) as any;
			let entries: any[] = [{ type: "compaction" }];
			ctx.sessionManager.getEntries = () => entries;
			importedModule2.registerFooter(fake.api);
			await fake.emit("session_start", {}, ctx);
			const component = ctx.ui.footer({ requestRender: vi.fn() }, theme, {
				getGitBranch: () => null,
				getFeatureStatuses: () => new Map(),
				onBranchChange: () => () => {},
			});
			const rendered = () => component.render(160).join("\n");
			expect(rendered()).toContain("1 compaction");
			await fake.emit("agent_start", {}, ctx);
			vi.advanceTimersByTime(18_000);
			expect(rendered()).not.toContain("running");
			await fake.emit("agent_end", {}, ctx);
			entries.push({ type: "compaction" });
			await fake.emit("session_compact", {}, ctx);
			await fake.emit("agent_start", {}, ctx);
			vi.advanceTimersByTime(2_000);
			expect(rendered()).toContain("2 compactions");
			await fake.emit("agent_settled", {}, ctx);
			vi.advanceTimersByTime(5_000);
			// `✻ Worked 20s` is the turn line's: the footer never repeats the run's time.
			expect(rendered()).not.toMatch(/last run|20s/);
			expect(vi.getTimerCount()).toBe(0);
			await fake.emit("agent_start", {}, ctx);
			component.dispose();
			expect(vi.getTimerCount()).toBe(0);
			entries = [];
			await fake.emit("session_start", {}, ctx);
			const fresh = ctx.ui.footer({ requestRender: vi.fn() }, theme, {
				getGitBranch: () => null,
				getFeatureStatuses: () => new Map(),
				onBranchChange: () => () => {},
			});
			expect(fresh.render(160).join("\n")).not.toContain("compaction");
			expect(fresh.render(160).join("\n")).not.toContain("last run");
			fresh.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps compact totals readable without overflowing narrow terminals", () => {
		for (const width of [0, 1, 20, 40, 80, 120, 200]) {
			const lines = footerLines({ ...state, running: true, compactions: 3 }, null, statuses, theme, width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			if (width >= 80) {
				expect(lines[0]).toContain("15.5k tok");
				expect(lines[1]).toContain("3 compactions");
			}
		}
	});
});

describe("permission chip in the footer", () => {
	it("paints the mode in its tone and the shortcut dim, and drops the shortcut when narrow", () => {
		painted.length = 0;
		const chip = chipParts("full", { actions: 12, warnings: 2 });
		const [top] = footerLines({ ...state, context: undefined, chip }, "main", new Map(), recording, 200);
		expect(top).toContain("⏵⏵ permission: full · shift+tab");
		expect(painted).toContainEqual(["warning", "⏵⏵ permission: full"]);
		expect(painted).toContainEqual(["dim", " · shift+tab"]);
		// The counters are zone A's, muted, not the chip's tone.
		expect(painted).toContainEqual(["muted", "12 actions · 2 ⚠"]);
		painted.length = 0;
		const [narrow] = footerLines({ ...state, context: undefined, chip }, "main", new Map(), recording, 44);
		expect(narrow).toContain("⏵⏵ full");
		expect(narrow).not.toContain("shift+tab");
		expect(painted).toContainEqual(["warning", "⏵⏵ full"]);
	});

	it("repaints when the published chip changes, and not when it repeats", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { chipOf, publishChip } = await import("../../src/octocode/permission/chip-store.ts");
		const fake = fakeHost();
		importedModule2.registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		await fake.emit("session_start", {}, ctx);
		const requestRender = vi.fn();
		const component = ctx.ui.footer({ requestRender }, theme, {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		});
		// The chip of this session (its feature setup): a process hosting several keeps one per session.
		const chip = chipOf(fake.api);
		publishChip(chip, chipParts("manual"));
		requestRender.mockClear();
		publishChip(chip, chipParts("full"));
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(component.render(120).join("\n")).toContain("⏵⏵ permission: full");
		publishChip(chip, chipParts("full"));
		expect(requestRender).toHaveBeenCalledTimes(1);
		component.dispose();
	});
});
