import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import { chipParts, chipText } from "../../src/octocode/permission/mode.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import * as importedModule2 from "../../src/octocode/ui/footer.ts";
import { contextBar, type FooterState, footerLines as paintFooter } from "../../src/octocode/ui/footer.ts";
import { reasoningTwin } from "../../src/octocode/ui/footer/notices.ts";
import * as importedModule1 from "./fake-host.ts";

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
	context: { percent: 42, limit: 200_000 },
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

describe("footer", () => {
	it("shows the model, context, mode and running work first, and where you are second", () => {
		const [top, bottom] = footerLines(state, "main", statuses, theme, 170);
		expect(top).toMatch(
			/^claude-opus-5-5 · ⏸ permission: manual · shift\+tab · thinking high · ctx ▰▰▰▱▱▱▱▱ 42% of 200k · agents 1\/2 ↑1k ↓2k · 1 bash +58 tok\/s · ≈\$0\.84$/,
		);
		expect(bottom).toBe("~/code/app ⎇ main · fix login · 15.5k tokens (↑12.4k ↓3.1k) · mcp 3/3 · lint ok");
		expect(visibleWidth(top)).toBe(170);
	});

	it("names the provider's kind beside the model, keeps (sub) on cost, and drops the kind first", () => {
		const sub: FooterState = { ...state, kind: "subscription", subscription: true };
		const [wide] = footerLines(sub, "main", statuses, theme, 200);
		expect(wide).toMatch(/^claude-opus-5-5 · subscription · ⏸ permission: manual/);
		expect(wide).toContain("≈$0.84 (sub)");
		const [narrow] = footerLines(sub, "main", statuses, theme, 150);
		expect(narrow).toMatch(/^claude-opus-5-5 · ⏸ permission: manual/);
		expect(narrow).toContain("ctx ▰▰▰▱▱▱▱▱ 42%");
	});

	it("colours context by how full it is", () => {
		expect(contextBar(30)).toEqual({ bar: "▰▰▱▱▱▱▱▱", color: "success" });
		// Any use shows: 3% is not an empty gauge.
		expect(contextBar(3).bar).toBe("▰▱▱▱▱▱▱▱");
		expect(contextBar(0).bar).toBe("▱▱▱▱▱▱▱▱");
		expect(contextBar(100).bar).toBe("▰▰▰▰▰▰▰▰");
		expect(contextBar(65).color).toBe("warning");
		expect(contextBar(91).color).toBe("error");
		painted.length = 0;
		footerLines({ ...state, context: { percent: 91, limit: 200_000 } }, "main", statuses, recording, 160);
		expect(painted.some(([color, text]) => color === "error" && text.includes("91%"))).toBe(true);
	});

	it("shows the last run's speed only between runs", () => {
		expect(footerLines(state, "main", statuses, theme, 200)[0]).toContain("58 tok/s");
		expect(footerLines({ ...state, running: true }, "main", statuses, theme, 200)[0]).not.toContain("tok/s");
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
		expect(lines[0]).toContain("model next part last");
		expect(lines[1]).toContain("/work/app next part last");
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
				context: { percent: null, limit: 200_000 },
				usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
				sessionName: undefined,
				chip: undefined,
			},
			null,
			new Map(),
			theme,
			120,
		);
		expect(top).toBe("claude-opus-5-5 · ctx ? of 200k");
		// Nothing spent and no compaction yet: no zero counters.
		expect(bottom).toBe("~/code/app");
	});

	it("drops the least important parts first on narrow terminals, never the model, context, permission mode or running work", () => {
		const [top, bottom] = footerLines(
			state,
			"feature/a-very-long-branch-name-for-testing",
			new Map([...statuses, ["other-ext", "lint ok · 12 warnings in 4 files"]]),
			theme,
			75,
		);
		expect(visibleWidth(top)).toBeLessThanOrEqual(75);
		expect(visibleWidth(bottom)).toBeLessThanOrEqual(75);
		expect(bottom).toContain("feature/a-very-long-bran…");
		for (const kept of ["claude-opus-5-5", "42%", "manual", "agents 1/2", "1 bash"]) expect(top).toContain(kept);
		expect(top).not.toContain("tok/s");
		expect(bottom).not.toContain("lint ok");
		// At 40 columns the mode chip is still there, in its short form (just the mode).
		const [narrow] = footerLines(
			{ ...state, context: undefined, chip: chipParts("full") },
			"main",
			new Map(),
			theme,
			40,
		);
		expect(narrow).toMatch(/^claude-opus-5-5 · ⏵⏵ full/);
		const [squeezed] = footerLines({ ...state, context: undefined, thinking: undefined }, "main", new Map(), theme, 26);
		expect(squeezed).toBe("claude-opus-5-5 · ⏸ manual");
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
		expect(footerLines(state, branch, new Map(), theme, 240)[1]).toContain(`${branch.slice(0, 79)}…`);
	});
});

describe("footer under a busy status row", () => {
	const busy = new Map([
		["octocode-team", "agents 3/6 ↑12k ↓34k"],
		["octocode-running", "3 agents · 2 bash · 1 timer"],
		["octocode-queued", "✉ 2 queued"],
		["octocode-hooks", "hook running 12s"],
	]);
	it("keeps the context percentage and thinking level ahead of ephemeral status counters at 80 and 120 columns", () => {
		for (const width of [80, 120]) {
			const lines = footerLines({ ...state, thinking: "medium", running: true }, "main", busy, theme, width);
			expect(lines[0], `ctx at ${width}`).toContain("ctx");
			expect(lines[0], `ctx percent at ${width}`).toContain("42%");
			expect(lines[0], `thinking at ${width}`).toMatch(/\b(medium|med)\b/);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

describe("footer wiring", () => {
	it("replaces Octocode's footer, sums the session usage and samples context on events", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api as unknown as { getThinkingLevel: () => string }).getThinkingLevel = () => "medium";
		// No compaction reserve: the gauge reads against the whole window.
		(fake.api as unknown as { getSettings: () => unknown }).getSettings = () => ({ compaction: { reserveTokens: 0 } });
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
			getExtensionStatuses: () => new Map([["mcp", "mcp 1/1"]]),
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
		const [initialTop, bottom] = component.render(120) as string[];
		expect(initialTop).toMatch(/^model-x · API key · thinking medium · ctx ▰▱{7} 12% of 83\.3k +≈\$0\.15$/);
		// ↑ is the whole prompt (uncached, cache reads and writes), with the share read from cache.
		expect(bottom).toBe("/work/app ⎇ main · 1.8k tokens (↑1.5k +3k cached ↓250) · mcp 1/1");
		percent = 64;
		await fake.emit(
			"message_end",
			{ message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.01 } } } },
			ctx,
		);
		expect(renders).toBe(1);
		const [top] = component.render(120) as string[];
		// 64k of the 83.3k limit: medium thinking enlarges the compaction reserve to a sixth of the 100k window.
		expect(top).toContain("77%");
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

	it("rebuilds the footer only when an input changed, samples context on replies and tree moves, not on tool results", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api as unknown as { getThinkingLevel: () => string }).getThinkingLevel = () => "medium";
		// No compaction reserve: the gauge reads against the whole window.
		(fake.api as unknown as { getSettings: () => unknown }).getSettings = () => ({ compaction: { reserveTokens: 0 } });
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
			getExtensionStatuses: () => statuses,
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
		expect((component.render(120) as string[])[0]).toContain("48%");
		component.invalidate();
		expect(component.render(120)).not.toBe(first);
	});

	it("reads the gauge against the auto-compaction point and counts background subagent reports in the cost", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api as unknown as { getThinkingLevel: () => string }).getThinkingLevel = () => "off";
		// A 1M window uses the built-in reserve even if legacy overrides remain on disk.
		(fake.api as unknown as { getSettings: () => unknown }).getSettings = () => ({
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
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		};
		const component = ctx.ui.footer({ requestRender: () => undefined }, theme, data);
		let [top, bottom] = component.render(120) as string[];
		expect(top).toContain("15% of 984k");
		expect(top).toContain("≈$1.50");
		expect(bottom).toContain("↑1k +9k cached");
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
		[top, bottom] = component.render(120) as string[];
		expect(top).toContain("≈$2.00");
		expect(bottom).toContain("↑2k +18k cached");
	});

	it("marks usage from a model without pricing instead of counting it as free, and says so once", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { registerFooter } = await Promise.resolve(importedModule2);
		const fake = fakeHost();
		(fake.api as unknown as { getThinkingLevel: () => string }).getThinkingLevel = () => "off";
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		const rates = (rate: number) => ({ cost: { input: rate, output: rate, cacheRead: rate, cacheWrite: rate } });
		ctx.modelRegistry = {
			billedBySubscription: () => false,
			getProviderKind: () => "local",
			find: (provider: string) => (provider === "local" ? rates(0) : rates(3)),
		};
		ctx.model = { id: "llama", reasoning: false, contextWindow: 100_000 };
		ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 });
		await fake.emit("session_start", {}, ctx);
		const data = {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
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
		(fake.api as unknown as { getThinkingLevel: () => string }).getThinkingLevel = () => "off";
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

	it("counts what full ran in the chip, and keeps the count in the short form", () => {
		expect(chipText("full")).toBe("⏵⏵ permission: full · shift+tab");
		expect(chipText("full", { actions: 0, warnings: 0 })).toBe("⏵⏵ permission: full · shift+tab");
		expect(chipText("full", { actions: 1, warnings: 0 })).toBe("⏵⏵ permission: full · 1 action · shift+tab");
		expect(chipText("full", { actions: 12, warnings: 2 })).toBe("⏵⏵ permission: full · 12 actions · 2 ⚠ · shift+tab");
		expect(chipText("workspace", { actions: 12, warnings: 2 })).toBe("permission: workspace · shift+tab");
		const chip = chipParts("full", { actions: 12, warnings: 2 });
		const [narrow] = footerLines({ ...state, context: undefined, chip }, "main", new Map(), theme, 44);
		expect(narrow).toContain("⏵⏵ full · 12 actions · 2 ⚠");
		expect(narrow).not.toContain("permission:");
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
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => {},
		});
		const rendered = () => component.render(200).join("\n");
		expect(rendered()).toContain("3.9k tokens");
		expect(rendered()).toContain("≈$0.35");
		await fake.emit("session_compact", { compactionEntry: { type: "compaction", usage: usage(1_000, 100, 0.1) } }, ctx);
		expect(rendered()).toContain("5k tokens");
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
				getExtensionStatuses: () => new Map(),
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
				getExtensionStatuses: () => new Map(),
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
				expect(lines.join("\n")).toContain("15.5k tokens");
				expect(lines.join("\n")).toContain("3 compactions");
			}
		}
	});
});

describe("permission chip in the footer", () => {
	it("paints the mode in its tone and the shortcut dim, and drops the shortcut when narrow", () => {
		painted.length = 0;
		const chip = chipParts("full", { actions: 12, warnings: 2 });
		const [top] = footerLines({ ...state, context: undefined, chip }, "main", new Map(), recording, 200);
		expect(top).toContain("⏵⏵ permission: full · 12 actions · 2 ⚠ · shift+tab");
		expect(painted).toContainEqual(["warning", "⏵⏵ permission: full · 12 actions · 2 ⚠"]);
		expect(painted).toContainEqual(["dim", " · shift+tab"]);
		const [narrow] = footerLines({ ...state, context: undefined, chip }, "main", new Map(), recording, 44);
		expect(narrow).toContain("⏵⏵ full · 12 actions · 2 ⚠");
		expect(narrow).not.toContain("shift+tab");
	});

	it("repaints when the published chip changes, and not when it repeats", async () => {
		const { fakeCtx, fakeHost } = await Promise.resolve(importedModule1);
		const { publishChip } = await import("../../src/octocode/permission/chip-store.ts");
		const fake = fakeHost();
		importedModule2.registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		await fake.emit("session_start", {}, ctx);
		const requestRender = vi.fn();
		const component = ctx.ui.footer({ requestRender }, theme, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		});
		publishChip(chipParts("manual"));
		requestRender.mockClear();
		publishChip(chipParts("full"));
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(component.render(120).join("\n")).toContain("⏵⏵ permission: full");
		publishChip(chipParts("full"));
		expect(requestRender).toHaveBeenCalledTimes(1);
		component.dispose();
	});
});
