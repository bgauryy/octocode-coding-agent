import type { ProfileEvent, ProfileFinding, ProfileFindingKind } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { num, str } from "./entries.ts";
import { RETRY_WAIT_LABEL, TURN_START_LABEL } from "./latency.ts";
import { PERMISSION_WAIT_LABEL, type Lane } from "./timeline.ts";

/** Thresholds of the latency analysis; each finding below says which one it used. */
const SLOW_PHASE_MS = 5_000;
const SLOW_FIRST_TOKEN_MS = 30_000;
const SLOW_TURN_START_MS = 10_000;
const RETRY_WAIT_MS = 10_000;
/** A stall at least this long is medium; shorter recorded stalls are low. */
const LONG_STALL_MS = 1_000;
const EVIDENCE = 10;

type ToolPhase = "prepare" | "queued" | "finalize" | "held";

const PHASE_TEXT: Record<ToolPhase, { title: string; detail: string }> = {
	prepare: {
		title: "waited before it ran (argument checks, hooks, permission check)",
		detail:
			"Time in argument validation, PreToolUse hooks and the permission check, with any wait for your answer left out. A slow hook or a permission rule that runs a command is the usual cause.",
	},
	queued: {
		title: "waited for the batch schedule",
		detail:
			"It waited for an exclusive call of the same message, or an exclusive call waited for every call before it. Calls that change state run alone.",
	},
	finalize: {
		title: "spent time after it ran (result hooks, output processing)",
		detail: "Time in PostToolUse hooks and result processing after the tool returned.",
	},
	held: {
		title: "had its result held for slower calls of the same message",
		detail:
			"Results of one message go back to the model together, so a fast call's result waits for the slowest call. Splitting long work into a background task frees the others.",
	},
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Milliseconds of the lane's permission waits inside `[from, to]`. */
function permissionOverlap(waits: readonly ProfileEvent[], from: number, to: number): number {
	let total = 0;
	for (const wait of waits)
		total += Math.max(0, Math.min(to, wait.at + (wait.durationMs ?? 0)) - Math.max(from, wait.at));
	return total;
}

/** A tool call's slowest phase outside its execution, the user's permission wait left out. */
function bottleneck(event: ProfileEvent, waits: readonly ProfileEvent[]): { phase: ToolPhase; ms: number } | undefined {
	const phases = event.phases ?? {};
	const queued = phases.queued ?? 0;
	const prepareEnd = event.at - queued;
	const prepare = event.early
		? 0
		: Math.max(0, (phases.prepare ?? 0) - permissionOverlap(waits, prepareEnd - (phases.prepare ?? 0), prepareEnd));
	const candidates: Array<{ phase: ToolPhase; ms: number }> = [
		{ phase: "prepare", ms: prepare },
		{ phase: "queued", ms: queued },
		{ phase: "finalize", ms: phases.finalize ?? 0 },
		{ phase: "held", ms: phases.held ?? 0 },
	];
	const worst = candidates.reduce((best, each) => (each.ms > best.ms ? each : best));
	return worst.ms > 0 ? worst : undefined;
}

interface Group {
	agentId: string;
	events: ProfileEvent[];
	total: number;
	worst: number;
}

function grouped(
	events: readonly ProfileEvent[],
	keyOf: (event: ProfileEvent) => string | undefined,
	ms: (event: ProfileEvent) => number,
): Map<string, Group> {
	const groups = new Map<string, Group>();
	for (const event of events) {
		const key = keyOf(event);
		if (key === undefined) continue;
		const group = groups.get(key) ?? { agentId: event.agentId, events: [], total: 0, worst: 0 };
		group.events.push(event);
		group.total += ms(event);
		group.worst = Math.max(group.worst, ms(event));
		groups.set(key, group);
	}
	return groups;
}

function finding(
	kind: ProfileFindingKind,
	key: string,
	group: Group,
	severity: ProfileFinding["severity"],
	title: string,
	detail: string,
): ProfileFinding {
	return {
		id: `${kind}:${key}`,
		kind,
		severity,
		title,
		detail,
		agentId: group.agentId,
		waitedMs: group.total,
		evidence: group.events.slice(0, EVIDENCE).map((event) => ({
			agentId: event.agentId,
			event: event.id,
			...(event.ref?.request === undefined ? {} : { request: event.ref.request }),
		})),
	};
}

const times = (group: Group): string =>
	group.events.length === 1 ? "" : ` (${group.events.length} times, worst ${seconds(group.worst)})`;

function toolPhaseFindings(events: readonly ProfileEvent[]): ProfileFinding[] {
	const waits = new Map<string, ProfileEvent[]>();
	for (const event of events)
		if (event.kind === "wait" && event.label === PERMISSION_WAIT_LABEL)
			waits.set(event.agentId, [...(waits.get(event.agentId) ?? []), event]);
	const slow = new Map<ProfileEvent, { phase: ToolPhase; ms: number }>();
	for (const event of events) {
		if (event.kind !== "tool" || !event.phases) continue;
		const found = bottleneck(event, waits.get(event.agentId) ?? []);
		if (found && found.ms >= SLOW_PHASE_MS) slow.set(event, found);
	}
	const groups = grouped(
		[...slow.keys()],
		(event) => `${event.agentId}|${event.label}|${slow.get(event)!.phase}`,
		(event) => slow.get(event)!.ms,
	);
	return [...groups].map(([key, group]) => {
		const phase = key.split("|")[2] as ToolPhase;
		const label = group.events[0].label;
		return finding(
			"slow-phase",
			key,
			group,
			group.worst >= 6 * SLOW_PHASE_MS ? "medium" : "low",
			`${label} ${PHASE_TEXT[phase].title}: ${seconds(group.total)}${times(group)}`,
			`${PHASE_TEXT[phase].detail} Its execution is listed separately (slow-tool).`,
		);
	});
}

/** Compaction entries of a lane inside `[from, to]`, for the turn-start detail. */
function compactedIn(lane: Lane | undefined, from: number, to: number): boolean {
	return (lane?.prepared?.entries ?? []).some((entry) => {
		if (entry.type !== "compaction") return false;
		const at = Date.parse(String(entry.timestamp));
		return at >= from && at <= to;
	});
}

function waitFindings(events: readonly ProfileEvent[], lanes: ReadonlyMap<string, Lane>): ProfileFinding[] {
	const found: ProfileFinding[] = [];
	const starts = grouped(
		events,
		(event) =>
			event.kind === "wait" && event.label === TURN_START_LABEL && (event.durationMs ?? 0) >= SLOW_TURN_START_MS
				? event.agentId
				: undefined,
		(event) => event.durationMs ?? 0,
	);
	for (const [key, group] of starts) {
		const compacted = group.events.some((event) =>
			compactedIn(lanes.get(event.agentId), event.at, event.at + (event.durationMs ?? 0)),
		);
		found.push(
			finding(
				"slow-turn-start",
				key,
				group,
				"low",
				`${key} took ${seconds(group.worst)} from a prompt to its first request${times(group)}`,
				`Between the prompt and the model request: prompt hooks, context assembly, memory recall and any compaction.${compacted ? " A compaction ran in this window." : ""}`,
			),
		);
	}
	const retries = grouped(
		events,
		(event) => (event.kind === "wait" && event.label === RETRY_WAIT_LABEL ? event.agentId : undefined),
		(event) => event.durationMs ?? 0,
	);
	for (const [key, group] of retries)
		if (group.total >= RETRY_WAIT_MS)
			found.push(
				finding(
					"retry-wait",
					key,
					group,
					group.total >= 6 * RETRY_WAIT_MS ? "medium" : "low",
					`${key} waited ${seconds(group.total)} on failed requests and their retries${times(group)}`,
					"From each failed request to its retry: the backoff or the provider's retry-after. The failed requests are on the timeline.",
				),
			);
	return found;
}

function requestFindings(events: readonly ProfileEvent[]): ProfileFinding[] {
	const groups = grouped(
		events,
		(event) =>
			event.kind === "request" && (event.phases?.firstToken ?? 0) >= SLOW_FIRST_TOKEN_MS ? event.agentId : undefined,
		(event) => event.phases?.firstToken ?? 0,
	);
	return [...groups].map(([key, group]) =>
		finding(
			"slow-first-token",
			key,
			group,
			"low",
			`${key} waited ${seconds(group.worst)} for a model's first token${times(group)}`,
			"Time to first token covers the connection, provider queueing and prompt processing; a large uncached prompt or a busy provider raises it. The cache findings name requests that sent their prompt again.",
		),
	);
}

function stallFindings(events: readonly ProfileEvent[], lanes: ReadonlyMap<string, Lane>): ProfileFinding[] {
	const maxOf = (event: ProfileEvent): number => {
		const entry = lanes.get(event.agentId)?.prepared?.entries[event.ref?.entry ?? -1];
		return num(asRecord(entry?.data).maxMs);
	};
	const duringOf = (event: ProfileEvent): string => {
		const entry = lanes.get(event.agentId)?.prepared?.entries[event.ref?.entry ?? -1];
		return str(asRecord(entry?.data).during, "the run");
	};
	const groups = grouped(
		events,
		(event) => (event.kind === "stall" ? `${event.agentId}|${duringOf(event)}` : undefined),
		maxOf,
	);
	return [...groups].map(([key, group]) => {
		const during = key.slice(key.indexOf("|") + 1);
		return finding(
			"main-thread-stall",
			key,
			group,
			group.worst >= LONG_STALL_MS ? "medium" : "low",
			`${group.agentId}'s event loop was blocked up to ${Math.round(group.worst)}ms during ${during}${group.events.length === 1 ? "" : ` (${group.events.length} windows)`}`,
			"Input, rendering and streaming stood still while synchronous work ran in this window. Profile the phase it names (node --cpu-prof) to find the code.",
		);
	});
}

/** Findings that name where time went: tool phases, first tokens, turn starts, retries and event-loop stalls. */
export function latencyFindings(events: readonly ProfileEvent[], lanes: readonly Lane[]): ProfileFinding[] {
	const byId = new Map(lanes.map((lane) => [lane.id, lane]));
	return [
		...toolPhaseFindings(events),
		...requestFindings(events),
		...waitFindings(events, byId),
		...stallFindings(events, byId),
	];
}
