import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
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
	context: { percent: 34, limit: 271_000 },
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
		const lines = footerLines({ ...busy, context: { percent: 86, limit: 271_000 } }, "main", statuses, recording, 80);
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

	it("writes Σ (sub) only when every priced reply was billed by a plan", () => {
		const plan = { ...idle, planBilled: { replies: 3, cost: 6.51 } };
		expect(render(plan, new Map(), 200)[0]).toMatch(/Σ \(sub\)$/);
		// A mixed session: a metered reply or a live agent's spend shows the money, never `(sub)`.
		const mixed = render({ ...idle, planBilled: { replies: 2, cost: 4 } }, new Map(), 200)[0];
		expect(mixed).toMatch(/Σ ≈\$6\.51$/);
		expect(render({ ...plan, live: [{ id: "a", cost: 1, unpriced: false }] }, new Map(), 200)[0]).toMatch(
			/Σ ≈\$7\.51$/,
		);
		expect(render(idle, new Map(), 200).join("\n")).not.toContain("(sub)");
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

	it("does not abbreviate a sibling of the home directory that shares its prefix", () => {
		const [top] = render({ ...idle, cwd: "/Users/me2/app" }, new Map(), 200);
		expect(top.startsWith("/Users/me2/app ⎇ main")).toBe(true);
	});
});
