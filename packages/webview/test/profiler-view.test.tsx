/** @vitest-environment jsdom */
import type { ProfileAgent, ProfileFinding, ProfileRequest } from "@octocodeai/octocode-contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { ProfilerFeed } from "../src/app/live/profiler-api.ts";
import { ProfilerView } from "../src/app/live/ProfilerView.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import { createWorkspaceStore } from "../src/state.ts";
import { agent, layer, request } from "./profiler-fixtures.ts";

const live: Record<string, unknown> = vi.hoisted(() => ({}));
vi.mock("../src/app/live/session.tsx", () => ({ useLive: () => live }));

const NOW = Date.now();
const agents: ProfileAgent[] = [
	agent("tidal-coral", {
		model: "opus-5-5",
		hitRate: 0.987,
		lastRequestAt: NOW,
		status: "working",
		requests: 3,
		contextWindow: 200_000,
		compactAt: 168_000,
		contextTokens: 128_000,
		contextLayers: [
			{ kind: "tools", tokens: 14_000 },
			{ kind: "message", tokens: 114_000 },
		],
		activity: { kind: "tool", label: "rg", since: NOW - 3000 },
	}),
	agent("shy-clam", { parentId: "tidal-coral", model: "sonnet", hitRate: 0.92, lastRequestAt: NOW - 3_600_000 }),
];
const main: ProfileRequest[] = [
	request("tidal-coral", 0, { usage: { input: 100, output: 5, cacheRead: 119_000, cacheWrite: 0, cost: 0.01 } }),
	request("tidal-coral", 1, {
		idleMs: 26 * 60_000,
		missReason: "idle past the cache lifetime",
		firstBreak: 1,
		usage: { input: 200, output: 5, cacheRead: 38_000, cacheWrite: 81_000, cost: 0.42 },
		layers: [
			layer({ kind: "tools", label: "tools (42)", tokens: 38_000 }),
			layer({
				kind: "system",
				label: "environment (date)",
				tokens: 9500,
				state: "written",
				changed: true,
				breakpoint: true,
			}),
			layer({ kind: "notice", label: "notice", tokens: 200, state: "uncached" }),
		],
		estimated: true,
	}),
];
const kid = [request("shy-clam", 0, { model: "sonnet" })];
const findings: ProfileFinding[] = [
	{ id: "f1", kind: "cost", severity: "low", title: "Cheap thing", detail: "d", cost: 0.01, evidence: [] },
	{
		id: "f2",
		kind: "cache-rewrite",
		severity: "high",
		title: "Section update rewrote 81k cached tokens",
		detail: "Move the update to the tail.",
		tokens: 81_000,
		evidence: [{ agentId: "tidal-coral", request: 0 }],
	},
];

function Harness({ panel }: { panel: string }) {
	const [params, setParams] = useState<Record<string, string>>({ panel });
	return (
		<ProfilerView
			index={indexBacklog({ repo: "r", generatedAt: 0, states: [], idleMs: 1, items: [] })}
			params={params}
			setParams={setParams}
		/>
	);
}

function setup(panel = "overview", profilerTrace = vi.fn(async () => new Blob(["{}"]))) {
	const feed = new ProfilerFeed();
	live.profiler = feed;
	live.workspace = createWorkspaceStore();
	const profilerRequests = vi.fn(async (id: string) => ({
		agentId: id,
		requests: id === "shy-clam" ? kid : main,
		hasMore: false,
	}));
	live.api = {
		profilerAgents: vi.fn(async () => ({ sessionId: "s", agents, generatedAt: NOW })),
		profilerRequests,
		profilerTimeline: vi.fn(async () => ({
			sessionId: "sess-1234abcd",
			events: [],
			messages: [],
			until: 0,
			hasMore: false,
		})),
		profilerTrace,
		profilerInsights: vi.fn(async () => ({ sessionId: "s", findings, generatedAt: NOW })),
	};
	render(<Harness panel={panel} />);
	return { feed, profilerRequests };
}
const agentRow = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name},`) });

it("lands on the Overview: KPI strip, agents with context bars, what runs now and the top findings", async () => {
	setup();
	const list = await screen.findByRole("list", { name: "Agents" });
	expect(within(list).getAllByRole("button", { name: /^(tidal-coral|shy-clam),/ })).toHaveLength(2);
	expect(
		screen.getByRole("img", { name: /^tidal-coral context 128k \/ 200k · 64%: tools 14k, history 114k$/ }),
	).toBeTruthy();
	expect(screen.getByRole("button", { name: /Running now/ }).textContent).toContain("1 of 2");
	expect(screen.getByRole("region", { name: "Right now" }).textContent).toContain("Tool: rg");
	expect(screen.getByRole("region", { name: /Top findings/ }).textContent).toContain("Section update rewrote 81k");
	expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");
});

it("opens the drawer on an agent, shows its context card and closes on Escape", async () => {
	const user = userEvent.setup();
	setup();
	await user.click(await agentRow("tidal-coral"));
	const drawer = await screen.findByRole("complementary", { name: "Details: tidal-coral" });
	expect(within(drawer).getByRole("table")).toBeTruthy();
	expect(within(drawer).getByRole("button", { name: "Request 1, 119k prompt, 32% cached" })).toBeTruthy();
	await user.click(within(drawer).getByRole("button", { name: "Request 1, 119k prompt, 32% cached" }));
	const request = await screen.findByLabelText("Request 1 of tidal-coral");
	expect(within(request).getByText("First break: environment (date)")).toBeTruthy();
	expect(within(request).getByText("▲ breakpoint")).toBeTruthy();
	await user.click(within(request).getByRole("button", { name: /Changed since previous \(1\)/ }));
	expect(within(request).getByRole("list", { name: "Changed layers" }).children).toHaveLength(1);
	await user.keyboard("{Escape}");
	expect(screen.queryByRole("complementary")).toBeNull();
});

it("opens a finding's request in the Trace with the drawer on it", async () => {
	const user = userEvent.setup();
	setup();
	await user.click(await screen.findByRole("button", { name: "Open: Section update rewrote 81k cached tokens" }));
	await screen.findByLabelText("Request 0 of tidal-coral");
	expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
});

it("counts live requests in the strip and holds them while paused", async () => {
	const user = userEvent.setup();
	const { feed } = setup();
	const tile = async () =>
		(await screen.findByRole("button", { name: /^Requests/ })).querySelector(".pf-kpi-figure")?.textContent;
	expect(await tile()).toBe("3");
	act(() => feed.emit({ agent: { ...agents[0], requests: 4 }, request: request("tidal-coral", 2) }));
	expect(await tile()).toBe("4");
	await user.click(screen.getByRole("button", { name: /Live/ }));
	act(() => feed.emit({ agent: { ...agents[0], requests: 5 }, request: request("tidal-coral", 3) }));
	expect(await tile()).toBe("4");
	await user.click(screen.getByRole("button", { name: /Paused · 1 new/ }));
	expect(await tile()).toBe("5");
});

it("switches panels with the arrow keys on the tab strip and sends retired panel names to their successor", async () => {
	const user = userEvent.setup();
	setup();
	const tab = await screen.findByRole("tab", { name: "Overview" });
	tab.focus();
	await user.keyboard("{ArrowRight}");
	expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
	cleanup();
	setup("requests");
	expect((await screen.findByRole("tab", { name: "Trace" })).getAttribute("aria-selected")).toBe("true");
});

it("shows skeletons, not the word Loading, until the agents arrive", () => {
	setup();
	expect(screen.getByRole("status", { name: "Loading the session summary" })).toBeTruthy();
});

it("exports the trace through the authenticated api and revokes the object URL", async () => {
	const user = userEvent.setup();
	const profilerTrace = vi.fn(async () => new Blob(["{}"]));
	const create = vi.fn(() => "blob:trace");
	const revoke = vi.fn();
	vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
	const saved: { href: string; download: string }[] = [];
	const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		saved.push({ href: this.href, download: this.download });
	});
	setup("overview", profilerTrace);
	await user.click(await screen.findByRole("button", { name: "Export trace" }));
	await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:trace"));
	expect(profilerTrace).toHaveBeenCalledTimes(1);
	expect(saved).toEqual([{ href: "blob:trace", download: "profiler-trace.json" }]);
	click.mockRestore();
	vi.unstubAllGlobals();
});

it("shows an error when the trace export fails", async () => {
	const user = userEvent.setup();
	const create = vi.fn();
	vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create }));
	setup(
		"overview",
		vi.fn(async () => {
			throw new Error("Could not export the trace");
		}),
	);
	await user.click(await screen.findByRole("button", { name: "Export trace" }));
	expect(await screen.findByText("Could not export the trace")).toBeTruthy();
	expect(create).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: "Export trace" })).toHaveProperty("disabled", false);
	vi.unstubAllGlobals();
});
