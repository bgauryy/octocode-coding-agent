import type {
	ProfileAgent,
	ProfileAgents,
	ProfileCacheState,
	ProfileRequest,
	ProfileRequests,
	ProfileUpdate,
	ProfileUsage,
} from "@octocodeai/octocode-contracts";

/** Anthropic's default cache lifetime; a longer idle gap or an older last request reads as cold. */
const CACHE_TTL_MS = 5 * 60_000;

export interface ProfilerState {
	agents: ProfileAgent[];
	/** Requests per agent, ascending by `index`, without gaps from the first one loaded. */
	requests: Record<string, ProfileRequest[]>;
	/** Per agent that was read: whether the host has more after the last loaded request. Absent: never read. */
	more: Record<string, boolean>;
	/** When the session's first agent started (epoch ms), as the host reported it. */
	startedAt?: number;
	agentId?: string;
	requestIndex?: number;
}

export const emptyProfiler: ProfilerState = { agents: [], requests: {}, more: {} };

function chooseAgent(state: ProfilerState): string | undefined {
	if (state.agentId && state.agents.some((agent) => agent.id === state.agentId)) return state.agentId;
	return (state.agents.find((agent) => !agent.parentId) ?? state.agents[0])?.id;
}

function withAgent(state: ProfilerState): ProfilerState {
	const agentId = chooseAgent(state);
	return agentId === state.agentId ? state : { ...state, agentId, requestIndex: undefined };
}

/** The agent list from the host replaces the rows; the selection stays when its agent still exists. */
export function applyAgents(state: ProfilerState, listed: ProfileAgents): ProfilerState {
	const starts = listed.agents.flatMap((agent) => agent.startedAt ?? []);
	return withAgent({
		...state,
		agents: listed.agents,
		startedAt: listed.startedAt ?? (starts.length ? Math.min(...starts) : undefined),
	});
}

function upsertAgent(agents: ProfileAgent[], agent: ProfileAgent): ProfileAgent[] {
	const at = agents.findIndex((item) => item.id === agent.id);
	if (at < 0) return [...agents, agent];
	return agents.map((item, position) => (position === at ? agent : item));
}

/** Merge a page: replace requests with the same index, add the rest, keep order. */
export function applyRequests(state: ProfilerState, page: ProfileRequests): ProfilerState {
	const byIndex = new Map((state.requests[page.agentId] ?? []).map((request) => [request.index, request]));
	for (const request of page.requests) byIndex.set(request.index, request);
	const merged = [...byIndex.values()].sort((a, b) => a.index - b.index);
	const next: ProfilerState = {
		...state,
		requests: { ...state.requests, [page.agentId]: merged },
		more: { ...state.more, [page.agentId]: page.hasMore },
	};
	// The first read selects the newest request; later pages and live rows never move the selection.
	if (page.agentId === state.agentId && state.requestIndex === undefined && merged.length && !page.hasMore)
		return { ...next, requestIndex: merged[merged.length - 1].index };
	return next;
}

/**
 * A live frame: the agent row is replaced. The request appends when it follows the loaded ones; a request past a gap
 * (frames missed while disconnected) is dropped and `more` is raised so the next read fills the gap.
 */
export function applyUpdate(state: ProfilerState, update: ProfileUpdate): ProfilerState {
	const next = withAgent({ ...state, agents: upsertAgent(state.agents, update.agent) });
	const { request } = update;
	const id = update.agent.id;
	const loaded = next.requests[id];
	if (!request || !loaded || next.more[id] === undefined) return next;
	const last = loaded.length ? loaded[loaded.length - 1].index : -1;
	if (request.index > last + 1) return { ...next, more: { ...next.more, [id]: true } };
	return applyRequests(next, { agentId: id, requests: [request], hasMore: next.more[id] });
}

/** Point the selection at a request that may not be loaded yet; it shows once its page arrives. */
export function focusRequest(state: ProfilerState, agentId: string, index: number): ProfilerState {
	return state.agents.some((agent) => agent.id === agentId) ? { ...state, agentId, requestIndex: index } : state;
}

export function selectAgent(state: ProfilerState, agentId: string): ProfilerState {
	if (agentId === state.agentId || !state.agents.some((agent) => agent.id === agentId)) return state;
	const loaded = state.requests[agentId];
	return {
		...state,
		agentId,
		// oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- undefined (never read) differs from false (fully read)
		requestIndex: loaded?.length && state.more[agentId] === false ? loaded[loaded.length - 1].index : undefined,
	};
}

/** The `after` value for the next read of an agent: absent until a first read, then the last loaded index. */
export function nextAfter(state: ProfilerState, agentId: string): number | undefined {
	const loaded = state.requests[agentId];
	if (state.more[agentId] === undefined || !loaded?.length) return undefined;
	return loaded[loaded.length - 1].index;
}

/** Move the selected request by `step` (clamped); `Infinity` and `-Infinity` go to the ends. */
export function stepRequest(state: ProfilerState, step: number): ProfilerState {
	const loaded = state.requests[state.agentId ?? ""] ?? [];
	if (!loaded.length) return state;
	const at = loaded.findIndex((request) => request.index === state.requestIndex);
	const target = Math.min(loaded.length - 1, Math.max(0, (at < 0 ? (step > 0 ? -1 : loaded.length) : at) + step));
	return { ...state, requestIndex: loaded[target].index };
}

export function selectedRequest(state: ProfilerState): ProfileRequest | undefined {
	return state.requests[state.agentId ?? ""]?.find((request) => request.index === state.requestIndex);
}

export interface AgentRow {
	agent: ProfileAgent;
	depth: number;
}

/** Coordinator first, children indented under their parent; an agent whose parent is not listed is a root. */
export function agentTree(agents: readonly ProfileAgent[]): AgentRow[] {
	const ids = new Set(agents.map((agent) => agent.id));
	const children = new Map<string | undefined, ProfileAgent[]>();
	for (const agent of agents) {
		const key = agent.parentId && ids.has(agent.parentId) && agent.parentId !== agent.id ? agent.parentId : undefined;
		children.set(key, [...(children.get(key) ?? []), agent]);
	}
	const rows: AgentRow[] = [];
	const seen = new Set<string>();
	const walk = (key: string | undefined, depth: number) => {
		for (const agent of children.get(key) ?? []) {
			if (seen.has(agent.id)) continue;
			seen.add(agent.id);
			rows.push({ agent, depth });
			walk(agent.id, depth + 1);
		}
	};
	walk(undefined, 0);
	return rows;
}

export interface Segment {
	state: ProfileCacheState;
	tokens: number;
}

/** The prompt's tokens split the way the provider counted them; a prompt under the minimum length is one `too-short` segment. */
export function requestSegments(request: ProfileRequest): Segment[] {
	const { input, cacheRead, cacheWrite } = request.usage;
	const tooShort =
		request.layers.length > 0 &&
		request.layers.every((layer) => layer.state === "too-short") &&
		!cacheRead &&
		!cacheWrite;
	const parts: Segment[] = tooShort
		? [{ state: "too-short", tokens: input }]
		: [
				{ state: "cached", tokens: cacheRead },
				{ state: "written", tokens: cacheWrite },
				{ state: "uncached", tokens: input },
			];
	return parts.filter((part) => part.tokens > 0);
}

export function promptTokens(usage: ProfileUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** cacheRead over the prompt, 0 to 1; absent for an empty or too-short prompt, where a hit rate means nothing. */
export function hitRatio(request: ProfileRequest): number | undefined {
	const total = promptTokens(request.usage);
	if (!total || requestSegments(request)[0]?.state === "too-short") return undefined;
	return request.usage.cacheRead / total;
}

/** One token scale per agent: the largest prompt among its loaded requests, so every bar compares to the others. */
export function tokenScale(requests: readonly ProfileRequest[]): number {
	return requests.reduce((most, request) => Math.max(most, promptTokens(request.usage)), 0);
}

export interface Marker {
	kind: "idle" | "interrupt" | "steer" | "notice" | "summary" | "miss";
	label: string;
	title: string;
}

export function requestMarkers(request: ProfileRequest, formatSpan: (ms: number) => string): Marker[] {
	const markers: Marker[] = [];
	if (request.idleMs !== undefined && request.idleMs > CACHE_TTL_MS)
		markers.push({
			kind: "idle",
			label: `idle ${formatSpan(request.idleMs)}`,
			title: `Idle ${formatSpan(request.idleMs)} since the previous request, past the ${formatSpan(CACHE_TTL_MS)} cache lifetime`,
		});
	for (const kind of ["interrupt", "steer", "notice", "summary"] as const) {
		const layers = request.layers.filter((layer) => layer.kind === kind);
		if (layers.length)
			markers.push({
				kind,
				label: layers.length > 1 ? `${kind} ×${layers.length}` : kind,
				title: layers.map((layer) => layer.label).join(", "),
			});
	}
	if (request.missReason) markers.push({ kind: "miss", label: "miss", title: request.missReason });
	return markers;
}

export interface Totals {
	requests: number;
	usage: ProfileUsage;
	/** Over the loaded requests whose prompt could be cached; absent when none could. */
	hitRate?: number;
}

/** Sums over the loaded requests: what the centre header shows for the selected agent. */
export function requestTotals(requests: readonly ProfileRequest[]): Totals {
	const usage: ProfileUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost: number | undefined;
	let readable = 0;
	let read = 0;
	for (const request of requests) {
		usage.input += request.usage.input;
		usage.output += request.usage.output;
		usage.cacheRead += request.usage.cacheRead;
		usage.cacheWrite += request.usage.cacheWrite;
		if (request.usage.cost !== undefined) cost = (cost ?? 0) + request.usage.cost;
		if (hitRatio(request) !== undefined) {
			readable += promptTokens(request.usage);
			read += request.usage.cacheRead;
		}
	}
	if (cost !== undefined) usage.cost = cost;
	return { requests: requests.length, usage, hitRate: readable ? read / readable : undefined };
}

/** `38k`, `0.2k`, `912`: tokens compact enough for a row. */
export function formatTokens(tokens: number): string {
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (tokens >= 100) return `${(tokens / 1000).toFixed(1)}k`;
	return String(Math.round(tokens));
}

export function formatPercent(ratio: number | undefined): string {
	return ratio === undefined ? "–" : `${Math.round(ratio * 100)}%`;
}

export function formatCost(cost: number | undefined): string {
	return cost === undefined ? "–" : `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** The screen-reader name of a request's bar. */
export function describeBar(request: ProfileRequest): string {
	const parts = requestSegments(request).map((segment) =>
		segment.state === "too-short"
			? `${formatTokens(segment.tokens)} too short to cache`
			: `${formatTokens(segment.tokens)} ${segment.state}`,
	);
	return parts.length ? parts.join(", ") : "no prompt tokens";
}
