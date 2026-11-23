import { setScreenReaderMode, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { StatusEntry } from "../../src/core/footer-data-provider.ts";
import { chipParts } from "../../src/octocode/permission/mode.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { fitFooterZones } from "../../src/octocode/ui/footer/fit.ts";
import { type FooterState, footerLines } from "../../src/octocode/ui/footer/rows.ts";

// The data of footer.md §4.3: 723k tokens (578k new prompt, 145k output), 96% read from cache, 34% of a 271k window.
const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
const usage = { input: 14_450_000, cacheRead: 13_872_000, output: 145_000, cost: 6.51, unpriced: false };
const idle: FooterState = {
	usage,
	model: "claude-opus-5-5",
	thinking: "high",
	kind: "subscription",
	context: { percent: 34, window: 271_000 },
	cwd: "/Users/me/code/octocodecode",
	home: "/Users/me",
	chip: { ...chipParts("manual"), key: "shift+tab" },
	githubToken: true,
};
const idleStatuses = new Map<string, StatusEntry>([
	[STATUS.backlog, { text: "backlog 12 open · 3 ongoing" }],
	[STATUS.speed, { text: "58 tok/s" }],
]);
// Busy: 5 agents and a bash job run, 2 messages wait, a plan is open, live agents spent another $6.62.
const busy: FooterState = {
	...idle,
	running: true,
	live: [{ id: "a1", cost: 6.62, unpriced: false }],
};
const busyStatuses = new Map<string, StatusEntry>([
	...idleStatuses,
	[STATUS.running, { text: "5 agents · 1 bash", tone: "accent" }],
	[STATUS.queued, { text: "✉ 2" }],
	[STATUS.plan, { text: "plan r2", tone: "warning" }],
	[STATUS.steps, { text: "3/7" }],
]);
const render = (state: FooterState, statuses: Map<string, StatusEntry>, width: number) =>
	footerLines(state, "main", statuses, plain, width);

afterEach(() => setScreenReaderMode(false));

describe("screen-reader text mode", () => {
	it("writes the context gauge as words, with no bar glyphs", () => {
		setScreenReaderMode(true);
		const rows = render(idle, idleStatuses, 120);
		expect(rows.join("\n")).toContain("context 34% of 271k");
		expect(rows.join("\n")).not.toMatch(/[▰▱]/);
	});
});

const pad = (left: string, center: string, right: string, width: number) => {
	const free = width - visibleWidth(left) - visibleWidth(center) - visibleWidth(right);
	const gap = Math.floor(free / 2);
	return `${left}${" ".repeat(gap)}${center}${" ".repeat(free - gap)}${right}`;
};
const ends = (left: string, right: string, width: number) =>
	`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

describe("footer zones (footer.md §4.3)", () => {
	it.each([
		[
			200,
			"~/code/octocodecode ⎇ main · ⏸ permission: manual · shift+tab",
			"ctx ▰▰▰▱▱▱▱▱ 34% of 271k · 723k tok (↑578k ↓145k) · 96% cached",
			"claude-opus-5-5:high · subscription",
			"backlog 12 open · 3 ongoing · ✓ GitHub · 58 tok/s · /providers · /model · /resume",
		],
		[
			120,
			"~/code/octocodecode ⎇ main · ⏸ manual · shift+tab",
			"ctx ▰▰▰▱▱▱▱▱ 34% of 271k · 723k tok · 96% cached",
			"claude-opus-5-5:high · subscription",
			"backlog 12 open · 3 ongoing · ✓ GitHub · 58 tok/s · … /status",
		],
		[
			80,
			"~/code/octocodecode ⎇ main · ⏸ manual",
			"ctx 34% · 723k tok · 96% cached",
			"claude-opus-5-5:high",
			"backlog 12 open · 3 ongoing · ✓ GitHub · … /status",
		],
	])(
		"idle at %i columns: environment, health and Σ on line 1, model:effort and details on line 2",
		(width, e, h, i, d) => {
			expect(render(idle, idleStatuses, width)).toEqual([pad(e, h, "Σ ≈$6.51", width), ends(i, d, width)]);
		},
	);

	it.each([
		[
			200,
			"~/code/octocodecode ⎇ main · ⏸ permission: manual · shift+tab · plan r2",
			"ctx ▰▰▰▱▱▱▱▱ 34% of 271k · 723k tok (↑578k ↓145k) · 96% cached",
			"5 agents · 1 bash · ✉ 2 · Σ ≈$13.13",
			"claude-opus-5-5:high · subscription",
			"3/7 · backlog 12 open · 3 ongoing · ✓ GitHub · /providers · /model · /resume",
		],
		[
			120,
			"~/code/octocodecode ⎇ main · ⏸ manual · plan r2",
			"ctx ▰▰▰▱▱▱▱▱ 34% · 723k tok · 96% cached",
			"5 agents · ✉ 2 · Σ ≈$13.13",
			"claude-opus-5-5:high · subscription",
			"3/7 · backlog 12 open · 3 ongoing · ✓ GitHub · … /status",
		],
		[
			80,
			"octocodecode ⎇ main · ⏸ manual · plan r2",
			"ctx 34%",
			"5 agents · ✉ 2 · Σ ≈$13.13",
			"claude-opus-5-5:high",
			"3/7 · backlog 12 open · 3 ongoing · ✓ GitHub · … /status",
		],
	])("busy at %i columns: counts collapse, the speed hides, Σ adds live agents", (width, e, h, a, i, d) => {
		expect(render(busy, busyStatuses, width)).toEqual([pad(e, h, a, width), ends(i, d, width)]);
	});

	it("keeps the context gauge in its alarm form above 80% and puts a warning on a row of its own", () => {
		const statuses = new Map(busyStatuses);
		statuses.delete(STATUS.plan);
		statuses.set("provider", { text: "provider error: retrying in 5m (a message cancels)", tone: "warning" });
		const calls: Array<[string, string]> = [];
		const recording = { fg: (tone: string, text: string) => (calls.push([tone, text]), text), bold: (t: string) => t };
		const lines = footerLines({ ...busy, context: { percent: 86, window: 271_000 } }, "main", statuses, recording, 80);
		expect(lines[0]).toBe(pad("octocodecode ⎇ main · ⏸ manual", "ctx ▰▰▰▰▰▰▰▱ 86%", "5 agents · ✉ 2 · Σ ≈$13.13", 80));
		expect(calls).toContainEqual(["error", "86%"]);
		expect(lines[2]).toBe("warning: provider error: retrying in 5m (a message cancels)");
	});

	it("draws the plan mark after the chip in the warning tone, at 60 columns too", () => {
		const calls: Array<[string, string]> = [];
		const recording = { fg: (tone: string, text: string) => (calls.push([tone, text]), text), bold: (t: string) => t };
		const [top] = footerLines(busy, "main", busyStatuses, recording, 60);
		expect(top).toContain("⏸ manual · plan r2");
		expect(calls).toContainEqual(["warning", "plan r2"]);
		expect(visibleWidth(top)).toBeLessThanOrEqual(60);
	});

	it("shows money apart from what plan-billed replies would cost, never adding the two", () => {
		const plan = { ...idle, planBilled: { replies: 3, cost: 6.51 } };
		expect(render(plan, new Map(), 200)[0]).toMatch(/Σ ~\$6\.51 plan$/);
		// A mixed session: the metered part is money, the plan part an estimate beside it.
		const mixed = render({ ...idle, planBilled: { replies: 2, cost: 4 } }, new Map(), 200)[0];
		expect(mixed).toMatch(/Σ ≈\$2\.51 · ~\$4\.00 plan$/);
		// A live agent's spend is money until its report says otherwise.
		expect(render({ ...plan, live: [{ id: "a", cost: 1, unpriced: false }] }, new Map(), 200)[0]).toMatch(
			/Σ ≈\$1\.00 · ~\$6\.51 plan$/,
		);
		// A live agent on a plan (its billing, as `subagents.maxCost` judges it) adds to the estimate, never to money.
		const planChild = { id: "p", cost: 2, unpriced: false, billing: "plan" as const };
		expect(render({ ...plan, live: [planChild] }, new Map(), 200)[0]).toMatch(/Σ ~\$8\.51 plan$/);
		expect(render({ ...idle, live: [planChild, { id: "m", cost: 1, unpriced: false }] }, new Map(), 200)[0]).toMatch(
			/Σ ≈\$7\.51 · ~\$2\.00 plan$/,
		);
		// A plan child under a parent that already reported is held by that report: not counted twice.
		const held = { ...plan, reported: new Set(["m"]), live: [{ ...planChild, parentId: "m" }] };
		expect(render(held, new Map(), 200)[0]).toMatch(/Σ ~\$6\.51 plan$/);
		expect(render(idle, new Map(), 200).join("\n")).not.toContain("plan$");
		// A plan paid for every reply and nothing priced them: no fake $0.
		const free = { ...idle, usage: { ...idle.usage, cost: 0 }, planBilled: { replies: 2, cost: 0 } };
		expect(render(free, new Map(), 200)[0]).toMatch(/Σ \(sub\)$/);
	});

	it("keeps a plan window past 90 % on a narrow row as a whole figure, and lets one at 70 % give way first", () => {
		const resetsAt = Date.now() + 3_600_000;
		const alarm = { ...idle, quota: { label: "5h", usedFraction: 0.92, resetsAt } };
		const warn = { ...idle, quota: { label: "5h", usedFraction: 0.72, resetsAt } };
		expect(render(alarm, new Map(), 200)[0]).toMatch(/quota 5h 92% · resets \d\d:\d\d · Σ/);
		for (const width of [40, 60, 80]) {
			const [top] = render(alarm, new Map(), width);
			expect(top, `${width}`).toMatch(/5h 92%/);
			expect(visibleWidth(top)).toBeLessThanOrEqual(width);
		}
		// Never a cut figure: the whole `5h 72%` or nothing.
		for (let width = 30; width <= 120; width++) expect(render(warn, new Map(), width)[0]).not.toMatch(/5h 7…|5h …/);
		expect(render({ ...idle, quota: undefined }, new Map(), 200)[0]).not.toContain("quota");
	});

	it("splits a session of $1.24 metered and $3.10 plan-estimated (RFC V8)", () => {
		const state = { ...idle, usage: { ...idle.usage, cost: 4.34 }, planBilled: { replies: 4, cost: 3.1 } };
		const calls: Array<[string, string]> = [];
		const recording = { fg: (tone: string, text: string) => (calls.push([tone, text]), text), bold: (t: string) => t };
		expect(footerLines(state, "main", new Map(), recording, 200)[0]).toMatch(/ Σ ≈\$1\.24 · ~\$3\.10 plan$/);
		// Money in the text tone; the estimate muted, so the two never read as one figure.
		expect(calls).toContainEqual(["text", "≈$1.24"]);
		expect(calls).toContainEqual(["muted", "~$3.10 plan"]);
		// An unpriced reply still warns beside the money.
		const unpriced = { ...state, usage: { ...state.usage, unpriced: true } };
		expect(footerLines(unpriced, "main", new Map(), plain, 200)[0]).toMatch(/ Σ ≈\$1\.24 \+ n\/a · ~\$3\.10 plan$/);
	});

	it("centers the middle zone between the outer ones, at least two columns from each", () => {
		const part = (text: string) => [{ text, priority: 1, keep: true }];
		const fit = (width: number) =>
			fitFooterZones({ left: part("left"), center: part("mid"), right: part("r") }, plain, width).line;
		expect(fit(20)).toBe("left      mid      r");
		expect(fit(12)).toBe("left  mid  r");
		expect(fitFooterZones({ left: part("left"), center: part("mid") }, plain, 20).line).toBe("left      mid");
	});

	it("keeps every line within the width at every column count", () => {
		for (let width = 1; width <= 220; width++)
			for (const line of [...render(idle, idleStatuses, width), ...render(busy, busyStatuses, width)])
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("elides a long path's middle before the permission chip or the context window shorten, before and after a turn", () => {
		const cwd = "/private/var/folders/nf/tf_qg9k56l97qnkcc2b_w5z40000gn/T/vt-Bl1RoK/octocode-real-process/project";
		const start = {
			...idle,
			cwd,
			chip: chipParts("full"),
			usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
		};
		const after = { ...start, usage: { input: 300, cacheRead: 0, output: 15, cost: 0.0003, unpriced: false } };
		for (const state of [start, after]) {
			const [top] = render(state, new Map(), 140);
			expect(top.startsWith("/…/octocode-real-process/project ⎇ main · ⏵⏵ permission: full · shift+tab")).toBe(true);
			expect(top).toContain("of 271k");
		}
	});

	it("moves a detail line 1 drops onto line 2's free room instead of pointing to /status", () => {
		const state = { ...idle, chip: chipParts("full", { actions: 12, warnings: 0 }) };
		const [top, bottom] = render(state, new Map(), 140);
		expect(top).not.toContain("12 actions");
		expect(bottom).toBe(
			ends("claude-opus-5-5:high · subscription", "12 actions · ✓ GitHub · /providers · /model · /resume", 140),
		);
		// Line 2's own details keep their place: a moved detail takes only the room the hints held.
		const crowded = render(state, idleStatuses, 120)[1];
		expect(crowded).toContain("backlog 12 open · 3 ongoing · ✓ GitHub · 58 tok/s");
		const narrow = render(state, idleStatuses, 100)[1];
		expect(narrow).toContain("backlog 12 open · 3 ongoing");
		expect(narrow).not.toContain("12 actions");
		expect(crowded).toContain("… /status");
	});

	it("writes <1% beside the one filled cell of a barely used context, never 0%", () => {
		const [top] = render({ ...idle, context: { percent: 0.2, window: 164_000 } }, new Map(), 200);
		expect(top).toContain("ctx ▰▱▱▱▱▱▱▱ <1% of 164k");
		expect(render({ ...idle, context: { percent: 0, window: 164_000 } }, new Map(), 200)[0]).toContain(
			"ctx ▱▱▱▱▱▱▱▱ 0% of 164k",
		);
	});

	it("does not abbreviate a sibling of the home directory that shares its prefix", () => {
		const [top] = render({ ...idle, cwd: "/Users/me2/app" }, new Map(), 200);
		expect(top.startsWith("/Users/me2/app ⎇ main")).toBe(true);
	});
});
