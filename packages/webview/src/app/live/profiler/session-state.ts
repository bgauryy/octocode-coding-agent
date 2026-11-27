import type {
	ProfileAgents,
	ProfileEvent,
	ProfileFinding,
	ProfileMessage,
	FeedCursor,
	ProfileMessages,
	ProfileRequest,
	ProfileRequests,
	ProfileTimeline,
	ProfileUpdate,
} from "@octocodeai/octocode-contracts";
import {
	agentTree,
	applyAgents,
	applyRequests,
	applyUpdate,
	emptyProfiler,
	focusRequest,
	selectAgent,
	stepRequest,
	type ProfilerState,
} from "../profiler-model.ts";
import type { ProfileRange, ProfileSelection } from "./panel-props.ts";

/** Everything the panels share: the loaded data, one selection, the brushed range, the filter and the pause. */
export interface ProfilerSession {
	core: ProfilerState;
	timeline: ProfileTimeline | undefined;
	findings: ProfileFinding[] | undefined;
	selection: ProfileSelection | undefined;
	range: ProfileRange | undefined;
	filter: string;
	/** Where the next older page of messages starts; `loaded` is false until a page was asked for, and no `next` after the last. */
	older: { loaded: boolean; next?: FeedCursor };
	paused: boolean;
	/** Live frames received while paused, coalesced per agent: the newest row, requests by index, events and messages by id. */
	held: HeldFrame[];
	/** How many live frames arrived while paused, for the toolbar's count. */
	heldFrames: number;
}

/** Everything a pause kept for one agent; a repeated row, request, event or message replaces its earlier copy. */
interface HeldFrame {
	agent: ProfileUpdate["agent"];
	requests: Map<number, ProfileRequest>;
	events: Map<string, ProfileEvent>;
	messages: Map<number, ProfileMessage>;
}

export const emptySession: ProfilerSession = {
	core: emptyProfiler,
	timeline: undefined,
	findings: undefined,
	selection: undefined,
	range: undefined,
	filter: "",
	older: { loaded: false },
	paused: false,
	held: [],
	heldFrames: 0,
};

export type SessionAction =
	| { type: "agents"; value: ProfileAgents }
	| { type: "requests"; value: ProfileRequests }
	| { type: "timeline"; value: ProfileTimeline }
	| { type: "insights"; value: ProfileFinding[] }
	| { type: "older"; value: ProfileMessages }
	| { type: "update"; value: ProfileUpdate }
	| { type: "select"; value: ProfileSelection | undefined }
	| { type: "step"; by: number }
	| { type: "range"; value: ProfileRange | undefined }
	| { type: "filter"; value: string }
	| { type: "pause"; value: boolean };

function mergeBy<T>(
	current: readonly T[],
	added: readonly T[],
	key: (item: T) => string | number,
	order: (item: T) => number,
) {
	const byKey = new Map(current.map((item) => [key(item), item]));
	for (const item of added) byKey.set(key(item), item);
	return [...byKey.values()].sort((a, b) => order(a) - order(b));
}

/** Add a page or frame of events and messages: events by id, messages by id, oldest first. */
export function mergeTimeline(
	current: ProfileTimeline | undefined,
	events: readonly ProfileEvent[],
	messages: readonly ProfileMessage[],
	patch: Partial<Pick<ProfileTimeline, "until" | "hasMore" | "sessionId">> = {},
): ProfileTimeline {
	const base = current ?? { sessionId: "", events: [], messages: [], until: 0, hasMore: false };
	const latest = events.reduce((most, event) => Math.max(most, event.at + (event.durationMs ?? 0)), base.until);
	return {
		...base,
		...patch,
		events: mergeBy(
			base.events,
			events,
			(event) => event.id,
			(event) => event.at,
		),
		messages: mergeBy(
			base.messages,
			messages,
			(message) => message.id,
			(message) => message.at,
		),
		until: patch.until ?? latest,
	};
}

/** Fold a frame into the held ones: agents keep their first-seen order, so a resume adds new agents as live frames would. */
function hold(held: readonly HeldFrame[], update: ProfileUpdate): HeldFrame[] {
	const at = held.findIndex((frame) => frame.agent.id === update.agent.id);
	const frame: HeldFrame =
		at < 0
			? { agent: update.agent, requests: new Map(), events: new Map(), messages: new Map() }
			: { ...held[at], agent: update.agent };
	if (update.request) frame.requests.set(update.request.index, update.request);
	for (const event of update.events ?? []) frame.events.set(event.id, event);
	for (const message of update.messages ?? []) frame.messages.set(message.id, message);
	return at < 0 ? [...held, frame] : held.map((item, position) => (position === at ? frame : item));
}

/** Requests after the first, applied as live frames would (one that skips past the loaded ones is dropped) but merged once. */
function applyRequestRun(core: ProfilerSession["core"], agentId: string, requests: ProfileRequest[]) {
	const loaded = core.requests[agentId];
	const more = core.more[agentId];
	if (!requests.length || !loaded || more === undefined) return core;
	let last = loaded.length ? loaded[loaded.length - 1].index : -1;
	const fit: ProfileRequest[] = [];
	for (const request of requests) {
		if (request.index > last + 1) break;
		last = Math.max(last, request.index);
		fit.push(request);
	}
	const merged = fit.length ? applyRequests(core, { agentId, requests: fit, hasMore: more }) : core;
	return fit.length < requests.length ? { ...merged, more: { ...merged.more, [agentId]: true } } : merged;
}

/** Resume: each agent's row and requests (ascending) reach the core; the timeline merges every event once. */
function release(session: ProfilerSession): ProfilerSession {
	let core = session.core;
	const events: ProfileEvent[] = [];
	const messages: ProfileMessage[] = [];
	for (const frame of session.held) {
		const requests = [...frame.requests.values()].sort((a, b) => a.index - b.index);
		core = applyUpdate(core, { agent: frame.agent, request: requests[0] });
		core = applyRequestRun(core, frame.agent.id, requests.slice(1));
		events.push(...frame.events.values());
		messages.push(...frame.messages.values());
	}
	const timeline =
		session.timeline && (events.length || messages.length)
			? mergeTimeline(session.timeline, events, messages)
			: session.timeline;
	return { ...session, core, timeline, paused: false, held: [], heldFrames: 0 };
}

function applyFrame(session: ProfilerSession, update: ProfileUpdate): ProfilerSession {
	const core = applyUpdate(session.core, update);
	const timeline =
		session.timeline && (update.events || update.messages)
			? mergeTimeline(session.timeline, update.events ?? [], update.messages ?? [])
			: session.timeline;
	return { ...session, core, timeline };
}

/** The agent `by` places after the selected one in tree order (clamped); the selection when there is none to move to. */
function neighbourAgent(session: ProfilerSession, by: number): ProfileSelection | undefined {
	const { selection } = session;
	if (selection?.kind !== "agent") return selection;
	const order = agentTree(session.core.agents).map((row) => row.agent.id);
	const at = order.indexOf(selection.agentId);
	const target = order[Math.min(order.length - 1, Math.max(0, at + by))];
	return target === undefined ? selection : { kind: "agent", agentId: target };
}

/** Choosing something in one panel moves the shared state the others read. */
function select(session: ProfilerSession, selection: ProfileSelection | undefined): ProfilerSession {
	if (!selection) return { ...session, selection: undefined };
	let core = session.core;
	if (selection.kind === "agent") core = selectAgent(core, selection.agentId);
	else if (selection.kind === "request") core = focusRequest(core, selection.agentId, selection.index);
	else if (selection.kind === "event") {
		const event = session.timeline?.events.find((item) => item.id === selection.id);
		if (event) {
			core = selectAgent(core, event.agentId);
			if (event.ref?.request !== undefined) core = focusRequest(core, event.agentId, event.ref.request);
		}
	}
	return { ...session, core, selection };
}

export function reduceSession(session: ProfilerSession, action: SessionAction): ProfilerSession {
	switch (action.type) {
		case "agents":
			return { ...session, core: applyAgents(session.core, action.value) };
		case "requests":
			return { ...session, core: applyRequests(session.core, action.value) };
		case "timeline":
			return {
				...session,
				timeline: mergeTimeline(session.timeline, action.value.events, action.value.messages, {
					sessionId: action.value.sessionId,
					until: Math.max(action.value.until, session.timeline?.until ?? 0),
					hasMore: action.value.hasMore,
				}),
			};
		case "insights":
			return { ...session, findings: action.value };
		case "older":
			return {
				...session,
				older: { loaded: true, ...(action.value.next ? { next: action.value.next } : {}) },
				timeline: mergeTimeline(session.timeline, [], action.value.messages),
			};
		case "update":
			return session.paused
				? { ...session, held: hold(session.held, action.value), heldFrames: session.heldFrames + 1 }
				: applyFrame(session, action.value);
		case "select":
			return select(session, action.value);
		case "step": {
			if (session.selection?.kind === "agent") return select(session, neighbourAgent(session, action.by));
			const core = stepRequest(session.core, action.by);
			const { agentId, requestIndex } = core;
			return {
				...session,
				core,
				selection:
					agentId !== undefined && requestIndex !== undefined
						? { kind: "request", agentId, index: requestIndex }
						: session.selection,
			};
		}
		case "range":
			return { ...session, range: action.value };
		case "filter":
			return { ...session, filter: action.value };
		case "pause":
			return action.value ? { ...session, paused: true } : release(session);
	}
}

/** Which layers differ from the request before: the Changes tab's rows. */
export function changedLayers(request: ProfileRequest) {
	return request.layers.map((layer, position) => ({ layer, position })).filter(({ layer }) => layer.changed);
}

/** Events narrowed by the range and the filter text (label, agent, peer, kind). */
export function visibleEvents(session: ProfilerSession): ProfileEvent[] {
	const text = session.filter.trim().toLowerCase();
	const { range } = session;
	return (session.timeline?.events ?? []).filter(
		(event) =>
			(!range || (event.at >= range.from && event.at <= range.to)) &&
			(!text ||
				[event.label, event.agentId, event.peer ?? "", event.kind].some((field) => field.toLowerCase().includes(text))),
	);
}

/** Findings narrowed by the filter text, most costly first; the host's order breaks ties. */
export function visibleFindings(session: ProfilerSession): ProfileFinding[] {
	const text = session.filter.trim().toLowerCase();
	const weight = (finding: ProfileFinding) =>
		(finding.cost ?? 0) * 1e6 + (finding.tokens ?? 0) + (finding.waitedMs ?? 0) / 1000;
	return (session.findings ?? [])
		.filter(
			(finding) =>
				!text ||
				[finding.title, finding.detail, finding.kind, finding.agentId ?? ""].some((field) =>
					field.toLowerCase().includes(text),
				),
		)
		.sort((a, b) => weight(b) - weight(a));
}

/** The loaded requests by agent id, in the shape every panel reads. */
export function sessionRequestMap(session: ProfilerSession): Map<string, ProfileRequest[]> {
	return new Map(Object.entries(session.core.requests));
}
