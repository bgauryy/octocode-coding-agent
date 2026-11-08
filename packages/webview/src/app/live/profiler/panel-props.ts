import type { ProfileAgent, ProfileRequest, ProfileTimeline } from "@octocodeai/octocode-contracts";

/**
 * What the person (or a link) picked; every panel highlights it and may change it. A selection opens the shared
 * drawer on that agent, request, event or message; selecting `undefined` closes it.
 */
export type ProfileSelection =
	| { kind: "agent"; agentId: string }
	| { kind: "request"; agentId: string; index: number }
	| { kind: "event"; id: string }
	| { kind: "message"; id: number };

/** A brushed span of time (epoch ms); panels show only what falls inside it. */
export interface ProfileRange {
	from: number;
	to: number;
}

export interface PanelProps {
	/** Tree order: the coordinator, then each agent under its parent. */
	agents: ProfileAgent[];
	/** Requests by agent id, loaded so far. */
	requests: Map<string, ProfileRequest[]>;
	timeline: ProfileTimeline | undefined;
	selection: ProfileSelection | undefined;
	/** Open the drawer on a row (or close it with `undefined`): the only way a panel shows detail. */
	onSelect(selection: ProfileSelection | undefined): void;
	range: ProfileRange | undefined;
	onRange(range: ProfileRange | undefined): void;
	/** The toolbar's filter text. */
	filter: string;
}
