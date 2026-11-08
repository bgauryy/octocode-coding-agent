import type {
	ProfileAgents,
	ProfileEvent,
	ProfileFinding,
	ProfileMessage,
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
	paused: boolean;
	/** Live frames received while paused, applied in order on resume. */
	held: ProfileUpdate[];
}

export const emptySession: ProfilerSession = {
	core: emptyProfiler,
	timeline: undefined,
	findings: undefined,
	selection: undefined,
	range: undefined,
	filter: "",
	paused: false,
	held: [],
};

export type SessionAction =
	| { type: "agents"; value: ProfileAgents }
	| { type: "requests"; value: ProfileRequests }
	| { type: "timeline"; value: ProfileTimeline }
	| { type: "insights"; value: ProfileFinding[] }
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
		case "update":
			return session.paused ? { ...session, held: [...session.held, action.value] } : applyFrame(session, action.value);
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
			return action.value
				? { ...session, paused: true }
				: { ...session.held.reduce(applyFrame, session), paused: false, held: [] };
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
