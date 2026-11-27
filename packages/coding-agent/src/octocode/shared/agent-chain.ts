/**
 * The channel (`api.channels`) on which the subagents domain announces the links of a chain: a child queued behind
 * prerequisites, released when they were met, or held because one failed. The hooks domain turns these into the
 * AgentQueued hook and the chain fields of AgentOn and AgentOff. Neither domain imports the other.
 */
/** Channel a completed backlog item announces itself on: the subagents domain answers with the items queued children start by themselves. */
export const BACKLOG_ENDED_CHANNEL = "octocode:backlog-ended";

/** A backlog write completed `ref`; a listener adds to `queued` the items a queued child will start, and reads the board again. */
export interface BacklogEnded {
	ref: string;
	queued: Set<string>;
}

/** Channel a successful backlog `done` announces itself on, after its write committed (the compaction domain listens). */
export const BACKLOG_DONE_CHANNEL = "octocode:backlog-done";

/** `ref` was completed with `summary`; `remaining` items assigned to this session are left, and `open` says there are some (the run goes on). */
export interface BacklogDone {
	ref: string;
	summary: string;
	open: boolean;
	remaining: number;
}

export const AGENT_CHAIN_CHANNEL = "octocode:agent-chain";

/** What a listener on `AGENT_CHAIN_CHANNEL` receives. `after`: the prerequisites by name (`B12`, `agent:sly-mantle`). */
export type AgentChainNotice =
	| { kind: "queued"; agent: string; role: string; after: string[]; item?: string }
	| {
			kind: "released";
			agent: string;
			role: string;
			after: string[];
			/** The `agent_events` sequence of the newest transition that met an agent prerequisite. */
			seq?: number;
	  }
	| { kind: "held"; agent: string; role: string; after: string[]; failed: string[] };
