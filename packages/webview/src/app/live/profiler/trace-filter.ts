import type { ProfileEvent } from "@octocodeai/octocode-contracts";
import type { ProfileRange } from "./panel-props.ts";
import type { RequestLookup } from "./trace-model.ts";
import { overlapsRange } from "./trace-view.ts";

/** Filtering for the Trace: the toolbar text, the brushed range, "problems only" and per-kind chips. */

export const KIND_CHIPS = [
	{ id: "requests", label: "Requests", kinds: ["request"] },
	{ id: "tools", label: "Tools", kinds: ["tool"] },
	{ id: "waits", label: "Waits", kinds: ["wait", "permission", "idle", "stall"] },
	{ id: "messages", label: "Messages", kinds: ["message"] },
] as const;
export type KindChip = (typeof KIND_CHIPS)[number]["id"];

export interface TraceFilter {
	range?: ProfileRange;
	text: string;
	problemsOnly: boolean;
	/** Chips switched off: their events are left out. */
	hidden: ReadonlySet<KindChip>;
}

/** An error or aborted call, an interrupt, or a request that broke the cached prefix. */
export function isProblem(event: ProfileEvent, lookup?: RequestLookup): boolean {
	if (event.outcome === "error" || event.outcome === "aborted" || event.kind === "interrupt" || event.kind === "stall")
		return true;
	if (event.kind !== "request" || event.ref?.request === undefined) return false;
	return lookup?.(event.agentId, event.ref.request)?.firstBreak !== undefined;
}

function eventMatches(event: ProfileEvent, filter: string): boolean {
	const needle = filter.trim().toLowerCase();
	if (!needle) return true;
	return [event.label, event.kind, event.agentId, event.peer ?? ""].some((text) => text.toLowerCase().includes(needle));
}

export function filterEvents(
	events: readonly ProfileEvent[],
	range: ProfileRange | undefined,
	filter: string,
): ProfileEvent[] {
	return events.filter(
		(event) => overlapsRange(event.at, event.at + (event.durationMs ?? 0), range) && eventMatches(event, filter),
	);
}

export function filterTrace(
	events: readonly ProfileEvent[],
	filter: TraceFilter,
	lookup?: RequestLookup,
): ProfileEvent[] {
	const off = new Set<string>(KIND_CHIPS.filter((chip) => filter.hidden.has(chip.id)).flatMap((chip) => chip.kinds));
	return filterEvents(events, filter.range, filter.text).filter(
		(event) => !off.has(event.kind) && (!filter.problemsOnly || isProblem(event, lookup)),
	);
}
