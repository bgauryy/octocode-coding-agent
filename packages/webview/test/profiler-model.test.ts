import { expect, it } from "vitest";
import {
	agentTree,
	applyAgents,
	applyRequests,
	applyUpdate,
	describeBar,
	emptyProfiler,
	formatTokens,
	hitRatio,
	nextAfter,
	requestMarkers,
	requestSegments,
	requestTotals,
	selectAgent,
	selectedRequest,
	stepRequest,
	tokenScale,
} from "../src/app/live/profiler-model.ts";
import { agent, layer, request } from "./profiler-fixtures.ts";

const listed = (...agents: ReturnType<typeof agent>[]) => ({ sessionId: "s", agents, generatedAt: 0 });

it("lists the coordinator first with children under their parent", () => {
	const rows = agentTree([
		agent("b", { parentId: "a" }),
		agent("c", { parentId: "b" }),
		agent("a"),
		agent("x", { parentId: "gone" }),
	]);
	expect(rows.map((row) => [row.agent.id, row.depth])).toEqual([
		["a", 0],
		["b", 1],
		["c", 2],
		["x", 0],
	]);
});

it("selects the coordinator by default and keeps a still-listed selection", () => {
	let state = applyAgents(emptyProfiler, listed(agent("kid", { parentId: "main" }), agent("main")));
	expect(state.agentId).toBe("main");
	state = selectAgent(state, "kid");
	state = applyAgents(
		state,
		listed(agent("main"), agent("kid", { parentId: "main" }), agent("new", { parentId: "main" })),
	);
	expect(state.agentId).toBe("kid");
	expect(applyAgents(state, listed(agent("main"))).agentId).toBe("main");
});

it("merges pages in order, replaces repeats, and pages on from the last index", () => {
	let state = applyAgents(emptyProfiler, listed(agent("main")));
	expect(nextAfter(state, "main")).toBeUndefined();
	state = applyRequests(state, { agentId: "main", requests: [request("main", 0), request("main", 1)], hasMore: true });
	expect(nextAfter(state, "main")).toBe(1);
	expect(state.requestIndex).toBeUndefined();
	state = applyRequests(state, {
		agentId: "main",
		requests: [request("main", 1, { model: "again" }), request("main", 2)],
		hasMore: false,
	});
	expect(state.requests.main.map((item) => item.index)).toEqual([0, 1, 2]);
	expect(state.requests.main[1].model).toBe("again");
	expect(selectedRequest(state)?.index).toBe(2);
});

it("appends live requests without moving the selection", () => {
	let state = applyAgents(emptyProfiler, listed(agent("main")));
	state = applyRequests(state, { agentId: "main", requests: [request("main", 0), request("main", 1)], hasMore: false });
	state = stepRequest(state, -1);
	expect(state.requestIndex).toBe(0);
	state = applyUpdate(state, { agent: agent("main", { requests: 3, status: "working" }), request: request("main", 2) });
	expect(state.requests.main.map((item) => item.index)).toEqual([0, 1, 2]);
	expect(state.requestIndex).toBe(0);
	expect(state.agents[0].status).toBe("working");
});

it("drops a live request past a gap and asks for a read; skips agents not read yet", () => {
	let state = applyAgents(emptyProfiler, listed(agent("main"), agent("kid", { parentId: "main" })));
	state = applyRequests(state, { agentId: "main", requests: [request("main", 0)], hasMore: false });
	state = applyUpdate(state, { agent: agent("main"), request: request("main", 5) });
	expect(state.requests.main).toHaveLength(1);
	expect(state.more.main).toBe(true);
	state = applyUpdate(state, { agent: agent("kid", { parentId: "main", hitRate: 0.5 }), request: request("kid", 0) });
	expect(state.requests.kid).toBeUndefined();
	expect(state.agents.find((item) => item.id === "kid")?.hitRate).toBe(0.5);
	state = applyUpdate(state, { agent: agent("fresh"), request: request("fresh", 0) });
	expect(state.agents.map((item) => item.id)).toContain("fresh");
});

it("steps within bounds and to the ends", () => {
	let state = applyAgents(emptyProfiler, listed(agent("main")));
	state = applyRequests(state, { agentId: "main", requests: [0, 1, 2].map((i) => request("main", i)), hasMore: false });
	expect(stepRequest(state, 1).requestIndex).toBe(2);
	expect(stepRequest(state, -Infinity).requestIndex).toBe(0);
	expect(stepRequest(stepRequest(state, -Infinity), -1).requestIndex).toBe(0);
	expect(stepRequest(state, Infinity).requestIndex).toBe(2);
});

it("derives segments, hit ratio, scale and totals from usage", () => {
	const warm = request("a", 0, { usage: { input: 200, output: 5, cacheRead: 38_000, cacheWrite: 81_000, cost: 0.1 } });
	expect(requestSegments(warm).map((segment) => segment.state)).toEqual(["cached", "written", "uncached"]);
	expect(describeBar(warm)).toBe("38k cached, 81k written, 0.2k uncached");
	expect(hitRatio(warm)).toBeCloseTo(38_000 / 119_200);
	const tiny = request("a", 1, {
		usage: { input: 900, output: 5, cacheRead: 0, cacheWrite: 0 },
		layers: [layer({ state: "too-short" })],
	});
	expect(requestSegments(tiny)).toEqual([{ state: "too-short", tokens: 900 }]);
	expect(hitRatio(tiny)).toBeUndefined();
	expect(describeBar(tiny)).toBe("0.9k too short to cache");
	expect(tokenScale([warm, tiny])).toBe(119_200);
	const totals = requestTotals([
		warm,
		tiny,
		request("a", 2, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	]);
	expect(totals.usage.cost).toBeCloseTo(0.1);
	expect(totals.hitRate).toBeCloseTo(38_000 / 119_200);
	expect(formatTokens(11_500)).toBe("12k");
	expect(formatTokens(1500)).toBe("1.5k");
});

it("marks idle gaps past the cache lifetime, interrupts, steers, notices and misses", () => {
	const markers = requestMarkers(
		request("a", 0, {
			idleMs: 26 * 60_000,
			missReason: "idle past the cache lifetime",
			layers: [layer({ kind: "notice", label: "date" }), layer({ kind: "steer" }), layer({ kind: "interrupt" })],
		}),
		(ms) => `${Math.round(ms / 60_000)}m`,
	);
	expect(markers.map((marker) => marker.kind)).toEqual(["idle", "interrupt", "steer", "notice", "miss"]);
	expect(markers[0].label).toBe("idle 26m");
	expect(requestMarkers(request("a", 1, { idleMs: 1000 }), String)).toEqual([]);
});
