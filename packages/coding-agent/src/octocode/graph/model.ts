/**
 * The work graph: one read model over the items, steps, agents, jobs, resources and waits of a workspace. It is a pure
 * function of the snapshots a caller passes in (`sources.ts` reads them): no clock, no database, nothing written.
 */

export const NODE_KINDS = ["item", "step", "agent", "job", "resource", "wait"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * - `depends`: item → the item it needs done first
 * - `parent`: item → its epic, step → its item
 * - `holds`: agent → the item it claimed, agent or job → the resource it holds
 * - `serves`: job or agent → the item it works for
 * - `owns`: agent → the job it started
 * - `waits`: wait → what it waits for
 * - `blocks`: running job or held resource → the item that needs it and may not start while another holds it
 */
export const EDGE_KINDS = ["depends", "parent", "holds", "serves", "owns", "waits", "blocks"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** `item:B12`, `step:T3`, `agent:sly-mantle`, `job:bash-4`, `resource:full-run`, `wait:#4`. */
export type NodeId = `${NodeKind}:${string}`;

export interface GraphNode {
	id: NodeId;
	kind: NodeKind;
	/** The id without its kind: `B12`, `bash-4`, `full-run`. */
	ref: string;
	/** The store's own state word (`ongoing`, `running`, `held`, `missing` for a prerequisite no snapshot has). */
	state: string;
	/** One line. */
	label: string;
	/** The row it came from, for `--json`: `items:B12`, `leases:7`, `bash-jobs:bash-4`. */
	source: string;
}

export interface GraphEdge {
	kind: EdgeKind;
	from: NodeId;
	to: NodeId;
}

export interface ItemSnap {
	ref: string;
	title: string;
	/** `backlog`, `todo`, `ongoing`, `done`. */
	state: string;
	type?: string;
	/** 0 is the most urgent. */
	priority: number;
	createdAt: number;
	/** The refs the item needs done first. */
	dependsOn: readonly string[];
	/** The epic the item sits under. */
	parent?: string;
	/** The agent that claimed it (`agent:` name), while it is ongoing. */
	holder?: string;
	/** Resources or jobs the item cannot start without; another holder of one blocks it. */
	needs?: readonly NodeId[];
}

export interface StepSnap {
	/** `T3`. */
	ref: string;
	goal: string;
	state: string;
	item?: string;
}

export interface AgentSnap {
	name: string;
	state: string;
	/** The item the agent was started for. */
	item?: string;
}

export interface JobSnap {
	id: string;
	label: string;
	state: string;
	item?: string;
	/** The agent that started it. */
	agent?: string;
	/** Where the row came from; `bash-jobs` for the in-process records, `jobs` for database rows. */
	from?: string;
}

/** The host's full-run lock as its owner record names it; the caller reads the record. */
export interface RunLockSnap {
	label: string;
	agent?: string;
	item?: string;
	job?: string;
}

/** Where a kind of job comes from: the running session's in-process records now, database rows later. */
export type JobSource = () => readonly JobSnap[];

export interface ResourceSnap {
	/** `full-run`, `lease:<path key>`. */
	id: string;
	label: string;
	/** The agent that holds it; a free resource has none and is left out of the graph. */
	owner?: string;
	job?: string;
	item?: string;
	from?: string;
}

export interface WaitSnap {
	id: string;
	label: string;
	state: string;
	/** What it waits for. */
	on?: NodeId;
}

export interface GraphSources {
	items?: readonly ItemSnap[];
	steps?: readonly StepSnap[];
	agents?: readonly AgentSnap[];
	jobs?: readonly JobSnap[];
	resources?: readonly ResourceSnap[];
	waits?: readonly WaitSnap[];
}

export interface WorkGraph {
	nodes: readonly GraphNode[];
	edges: readonly GraphEdge[];
	node(id: NodeId): GraphNode | undefined;
	/** Edges leaving `id`, of `kind` when given. */
	out(id: NodeId, kind?: EdgeKind): GraphEdge[];
	/** Edges arriving at `id`, of `kind` when given. */
	into(id: NodeId, kind?: EdgeKind): GraphEdge[];
}

export const nodeId = (kind: NodeKind, ref: string): NodeId => `${kind}:${ref}`;

/** The graph of `sources`; an edge whose end no snapshot names is dropped, except a prerequisite, which becomes a `missing` item. */
export function workGraph(sources: GraphSources): WorkGraph {
	const nodes = new Map<NodeId, GraphNode>();
	const edges: GraphEdge[] = [];
	const add = (kind: NodeKind, ref: string, state: string, label: string, source: string) =>
		nodes.set(nodeId(kind, ref), { id: nodeId(kind, ref), kind, ref, state, label, source });
	const edge = (kind: EdgeKind, from: NodeId, to: NodeId) => edges.push({ kind, from, to });

	for (const item of sources.items ?? [])
		add("item", item.ref, item.state, `${item.ref} ${item.title}`, `items:${item.ref}`);
	for (const step of sources.steps ?? [])
		add("step", step.ref, step.state, `${step.ref} ${step.goal}`, `tasks:${step.ref}`);
	for (const agent of sources.agents ?? []) add("agent", agent.name, agent.state, agent.name, `agents:${agent.name}`);
	for (const job of sources.jobs ?? []) add("job", job.id, job.state, job.label, `${job.from ?? "jobs"}:${job.id}`);
	for (const wait of sources.waits ?? []) add("wait", wait.id, wait.state, wait.label, `timers:${wait.id}`);
	for (const resource of sources.resources ?? [])
		if (resource.owner !== undefined)
			add("resource", resource.id, "held", resource.label, `${resource.from ?? "leases"}:${resource.id}`);

	const has = (id: NodeId) => nodes.has(id);
	const link = (kind: EdgeKind, from: NodeId, to: NodeId | undefined) => {
		if (to !== undefined && has(from) && has(to)) edge(kind, from, to);
	};

	for (const item of sources.items ?? []) {
		const self = nodeId("item", item.ref);
		for (const ref of item.dependsOn) {
			const target = nodeId("item", ref);
			if (!has(target)) add("item", ref, "missing", `${ref} (not found)`, `items:${ref}`);
			edge("depends", self, target);
		}
		if (item.parent !== undefined) link("parent", self, nodeId("item", item.parent));
		if (item.holder !== undefined) link("holds", nodeId("agent", item.holder), self);
	}
	for (const step of sources.steps ?? [])
		if (step.item !== undefined) link("parent", nodeId("step", step.ref), nodeId("item", step.item));
	for (const agent of sources.agents ?? [])
		if (agent.item !== undefined) link("serves", nodeId("agent", agent.name), nodeId("item", agent.item));
	for (const job of sources.jobs ?? []) {
		const self = nodeId("job", job.id);
		if (job.item !== undefined) link("serves", self, nodeId("item", job.item));
		if (job.agent !== undefined) link("owns", nodeId("agent", job.agent), self);
	}
	for (const resource of sources.resources ?? []) {
		if (resource.owner === undefined) continue;
		const self = nodeId("resource", resource.id);
		link("holds", nodeId("agent", resource.owner), self);
		if (resource.job !== undefined) link("holds", nodeId("job", resource.job), self);
		if (resource.item !== undefined) link("serves", self, nodeId("item", resource.item));
	}
	for (const wait of sources.waits ?? []) link("waits", nodeId("wait", wait.id), wait.on);
	for (const item of sources.items ?? []) {
		const self = nodeId("item", item.ref);
		for (const need of item.needs ?? []) {
			// A holder's own resources never block it.
			const holder = item.holder === undefined ? undefined : nodeId("agent", item.holder);
			const own = edges.some((e) => (e.kind === "holds" || e.kind === "owns") && e.to === need && e.from === holder);
			if (!own) link("blocks", need, self);
		}
	}

	const list = [...nodes.values()];
	return {
		nodes: list,
		edges,
		node: (id) => nodes.get(id),
		out: (id, kind) => edges.filter((e) => e.from === id && (kind === undefined || e.kind === kind)),
		into: (id, kind) => edges.filter((e) => e.to === id && (kind === undefined || e.kind === kind)),
	};
}
