/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextBar } from "../src/app/live/profiler/ContextBar.tsx";
import { contextLevel, contextSegments } from "../src/app/live/profiler/context-model.ts";
import { buildRoster, cacheColdIn, computeKpis, describeActivity, hitSeries } from "../src/app/live/profiler/kpis.ts";
import { OverviewPanel } from "../src/app/live/profiler/OverviewPanel.tsx";
import { formatClock, setClockSkew, useNow } from "../src/app/live/profiler/use-now.ts";
import { agent, request } from "./profiler-fixtures.ts";

const NOW = 1_800_000_000_000;
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	setClockSkew(0);
});

const working = agent("main", {
	status: "working",
	model: "opus",
	contextWindow: 200_000,
	compactAt: 168_000,
	contextTokens: 128_000,
	contextLayers: [
		{ kind: "tools", tokens: 14_000 },
		{ kind: "system", tokens: 9000 },
		{ kind: "message", tokens: 61_000 },
		{ kind: "tool-result", tokens: 42_000 },
		{ kind: "notice", tokens: 2000 },
	],
	activity: { kind: "request", label: "opus", since: NOW - 12_000 },
	totals: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, cost: 0.84 },
	requests: 4,
});
const idle = agent("kid", {
	parentId: "main",
	role: "explore",
	lastRequestAt: NOW - 60_000,
	cacheTtlMs: 300_000,
	contextTokens: 34_000,
	contextWindow: 200_000,
});
const ended = agent("old", { parentId: "main", outcome: "done", endedAt: NOW - 240_000, contextTokens: 5000 });
const noWindow = agent("bare", {
	parentId: "main",
	contextTokens: 7000,
	contextLayers: [{ kind: "tools", tokens: 7000 }],
});

function overview(agents = [working, idle, ended], extra: Partial<Parameters<typeof OverviewPanel>[0]> = {}) {
	vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
	return render(
		<OverviewPanel
			loaded
			agents={agents}
			requests={new Map()}
			findings={[]}
			selection={undefined}
			filter=""
			startedAt={NOW - 3_600_000}
			onSelect={vi.fn()}
			onNavigate={vi.fn()}
			{...extra}
		/>,
	);
}

describe("kpis", () => {
	it("derives the six tiles", () => {
		const kpis = computeKpis({
			agents: [working, idle, ended],
			requests: new Map([
				["main", [request("main", 0, { durationMs: 2000 }), request("main", 1, { durationMs: 4000 })]],
			]),
			findings: [
				{ id: "a", kind: "cost", severity: "high", title: "t", detail: "", evidence: [] },
				{ id: "b", kind: "cost", severity: "low", title: "t", detail: "", evidence: [] },
			],
			now: NOW,
			startedAt: NOW - 3_600_000,
		});
		const by = Object.fromEntries(kpis.map((kpi) => [kpi.id, kpi]));
		expect(by.running).toMatchObject({ figure: "1 of 2", sub: "longest 12s" });
		expect(by.context).toMatchObject({ figure: "64%", sub: "128k/200k · main" });
		expect(by.cache.figure).toBe("90%");
		expect(by.cost).toMatchObject({ figure: "$0.84", sub: "$0.84/h" });
		expect(by.requests).toMatchObject({ figure: "4", sub: "avg 3.0s" });
		expect(by.attention).toMatchObject({ figure: "1", tone: "danger" });
	});

	it("degrades without windows, measurements or findings", () => {
		const kpis = computeKpis({
			agents: [noWindow],
			requests: new Map(),
			findings: undefined,
			now: NOW,
			startedAt: undefined,
		});
		expect(kpis.find((kpi) => kpi.id === "context")).toMatchObject({ figure: "7k", sub: "window unknown · bare" });
		expect(kpis.find((kpi) => kpi.id === "cache")?.figure).toBe("–");
		expect(kpis.find((kpi) => kpi.id === "cost")?.sub).toBe("");
		expect(
			computeKpis({ agents: [], requests: new Map(), findings: [], now: NOW, startedAt: undefined })[1].figure,
		).toBe("–");
	});

	it("warns near compaction, counts waits, describes activity and the cold countdown", () => {
		const near = agent("n", { contextTokens: 150_000, contextWindow: 200_000, compactAt: 168_000 });
		const waiting = agent("w", {
			status: "working",
			activity: { kind: "wait", label: "reply", since: NOW, peer: "kid" },
		});
		const kpis = computeKpis({
			agents: [near, waiting],
			requests: new Map(),
			findings: [],
			now: NOW,
			startedAt: undefined,
		});
		expect(kpis[1].tone).toBe("warn");
		expect(kpis[5]).toMatchObject({ figure: "1", sub: "1 waiting · 0 findings" });
		expect(describeActivity(waiting.activity).text).toBe("Waiting: reply from kid");
		expect(describeActivity({ kind: "tool", label: "rg", since: 0, count: 3 }).text).toBe("Tool: rg ×3");
		expect(cacheColdIn(idle, NOW)).toBe(240_000);
		expect(cacheColdIn(agent("x"), NOW)).toBeUndefined();
		expect(hitSeries(new Map([["a", [request("a", 0), request("a", 1)]]]))).toHaveLength(2);
	});

	it("orders working first, nests children and sets ended agents apart", () => {
		const roster = buildRoster([ended, idle, working], { sort: "activity", workingOnly: false, text: "" });
		expect(roster.rows.map((row) => [row.agent.id, row.depth])).toEqual([
			["main", 0],
			["kid", 1],
		]);
		expect(roster.ended.map((row) => row.id)).toEqual(["old"]);
		expect(
			buildRoster([working, idle], { sort: "activity", workingOnly: true, text: "" }).rows.map((r) => r.agent.id),
		).toEqual(["main"]);
		expect(
			buildRoster([working, idle], { sort: "context", workingOnly: false, text: "explore" }).rows.map(
				(r) => r.agent.id,
			),
		).toEqual(["kid"]);
	});
});

describe("ContextBar", () => {
	it("stacks layers on the window with a compaction tick and says so in text", () => {
		render(
			<ContextBar label="main" tokens={128_000} window={200_000} compactAt={168_000} layers={working.contextLayers} />,
		);
		expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
			"main context 128k / 200k · 64%: tools 14k, system 9k, history 61k, tool results 42k, notices 2k",
		);
		expect(screen.getByText(/compacts at 168k/)).toBeTruthy();
		expect(document.querySelector(".pf-ctx-tick")).toBeTruthy();
	});

	it("flags danger at 90% of the threshold, shows tokens alone without a window and marks estimates", () => {
		render(<ContextBar tokens={160_000} window={200_000} compactAt={168_000} estimated />);
		expect(screen.getByText(/⚠ compaction soon/)).toBeTruthy();
		expect(screen.getByText(/^≈ 160k \/ 200k/)).toBeTruthy();
		cleanup();
		render(<ContextBar tokens={7000} layers={[{ kind: "tools", tokens: 7000 }]} />);
		expect(screen.getByText("7k tokens")).toBeTruthy();
		cleanup();
		render(<ContextBar />);
		expect(screen.getByText("No context measured yet")).toBeTruthy();
	});

	it("puts what the layers do not cover under output and folds slivers into notices", () => {
		expect(contextSegments([{ kind: "tools", tokens: 900 }], 1000, 1000)).toEqual([
			{ key: "tools", tokens: 900 },
			{ key: "output", tokens: 100 },
		]);
		expect(
			contextSegments(
				[
					{ kind: "tools", tokens: 99_000 },
					{ kind: "system", tokens: 100 },
				],
				99_100,
				200_000,
			),
		).toEqual([
			{ key: "tools", tokens: 99_000 },
			{ key: "other", tokens: 100 },
		]);
		expect([contextLevel(60, 100), contextLevel(75, 100), contextLevel(95, 100), contextLevel(1, undefined)]).toEqual([
			"ok",
			"warn",
			"danger",
			"ok",
		]);
	});
});

describe("Overview agent rows", () => {
	it("shows a working agent with its activity, a ticking timer, its context and the layer key", () => {
		overview([working]);
		const row = screen.getByRole("button", { name: /^main,/ });
		expect(within(row).getByText("Thinking")).toBeTruthy();
		expect(within(row).getByText("00:12")).toBeTruthy();
		expect(within(row).getByText("$0.84")).toBeTruthy();
		expect(within(row).getByRole("list", { name: "Context by layer" })).toBeTruthy();
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(within(row).getByText("00:15")).toBeTruthy();
	});

	it("counts down an idle agent's cache and shows it cold afterwards", () => {
		overview([working, idle]);
		expect(screen.getByText("04:00")).toBeTruthy();
		act(() => {
			vi.advanceTimersByTime(241_000);
		});
		expect(screen.getByText("cache cold")).toBeTruthy();
	});

	it("keeps ended agents behind a toggle, dimmed, with the outcome and when", () => {
		overview();
		expect(screen.queryByRole("list", { name: "Ended agents" })).toBeNull();
		act(() => screen.getByRole("button", { name: /Ended \(1\)/ }).click());
		const row = within(screen.getByRole("list", { name: "Ended agents" })).getByRole("button");
		expect(row.className).toContain("is-ended");
		expect(row.textContent).toContain("done");
		expect(row.textContent).toContain("ended 4m ago");
	});

	it("shows tokens without a percentage when the window is unknown, and a note without context", () => {
		overview([agent("main"), noWindow, agent("quiet", { parentId: "main" })]);
		expect(screen.getByText("7k tokens")).toBeTruthy();
		expect(screen.getAllByText("No context measured yet")).toHaveLength(2);
	});

	it("explains an empty session and shows skeletons while loading", () => {
		overview([]);
		expect(screen.getByText("No requests yet")).toBeTruthy();
		cleanup();
		overview([], { loaded: false });
		expect(screen.getByRole("status", { name: "Loading agents" })).toBeTruthy();
	});

	it("sends the tiles to their filters and panels", () => {
		const onNavigate = vi.fn();
		overview([working, idle], { onNavigate });
		act(() => screen.getByRole("button", { name: /^Running now/ }).click());
		expect(screen.queryByRole("button", { name: /^kid,/ })).toBeNull();
		act(() => screen.getByRole("button", { name: /^Cache hit/ }).click());
		expect(onNavigate).toHaveBeenCalledWith("cache");
	});
});

describe("the shared clock", () => {
	beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] }));

	it("ticks once a second for every subscriber and follows the host's skew", () => {
		const a = renderHook(() => useNow());
		const b = renderHook(() => useNow());
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(a.result.current).toBe(NOW + 2000);
		expect(b.result.current).toBe(NOW + 2000);
		act(() => setClockSkew(5000));
		expect(a.result.current).toBe(NOW + 2000 - 5000);
		expect(formatClock(75_000)).toBe("01:15");
		expect(formatClock(3_725_000)).toBe("1:02:05");
	});
});
