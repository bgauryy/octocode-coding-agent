import { agentRuns, type AgentDb, leases, timers } from "../../../../db/src/api.ts";
import type { Item } from "./item.ts";
import type { BacklogStore } from "./store.ts";
import { listTasks } from "./tasks/reads.ts";
import type {
	AgentSnap,
	GraphSources,
	ItemSnap,
	JobSource,
	NodeId,
	ResourceSnap,
	RunLockSnap,
	StepSnap,
	WaitSnap,
} from "../graph/model.ts";
import { nodeId } from "../graph/model.ts";

export interface SourceInputs {
	agentDb: AgentDb;
	store: BacklogStore;
	/** The workspace id (`workspaces.id`) the items belong to. */
	repo: string;
	/** The workspace root, which names its leases. */
	root: string;
	now: number;
	/** Jobs, one function per origin; none reads a database table yet. */
	jobs?: readonly JobSource[];
	runLock?: RunLockSnap | undefined;
	/** The session whose waits to list; a command with no session lists none. */
	session?: string;
}

const OPEN = ["backlog", "todo", "ongoing"] as const;

function itemSnap(item: Item): ItemSnap {
	return {
		ref: item.ref,
		title: item.title,
		state: item.state,
		type: item.type,
		priority: item.priority,
		createdAt: item.createdAt,
		dependsOn: item.dependsOn.map((ref) => ref.id),
		...(item.parentId === undefined ? {} : { parent: item.parentId }),
		...(item.state === "ongoing" && item.assignee ? { holder: item.assignee } : {}),
	};
}

/** The open items and the done items they depend on, so a met prerequisite shows as done and an absent one as missing. */
export function itemSnaps(store: BacklogStore): ItemSnap[] {
	const open = store.list({ states: [...OPEN] }).items;
	const known = new Set(open.map((item) => item.ref));
	const done: Item[] = [];
	for (const ref of open.flatMap((item) => item.dependsOn.map((dep) => dep.id))) {
		if (known.has(ref)) continue;
		known.add(ref);
		const found = store.get(ref);
		if (found) done.push(found);
	}
	return [...open, ...done].map(itemSnap);
}

function agentSnaps(agentDb: AgentDb, repo: string, items: readonly ItemSnap[]): AgentSnap[] {
	const seqs = items.filter((item) => item.state !== "done").map((item) => Number(item.ref.slice(1)));
	const byName = new Map<string, AgentSnap>();
	for (const run of agentRuns.openForItems(agentDb.db, repo, seqs))
		if (!byName.has(run.agentId)) byName.set(run.agentId, { name: run.agentId, state: "running", item: `B${run.seq}` });
	for (const item of items)
		if (item.holder !== undefined && !byName.has(item.holder))
			byName.set(item.holder, { name: item.holder, state: "claimant" });
	return [...byName.values()];
}

function stepSnaps(agentDb: AgentDb, repo: string): StepSnap[] {
	return listTasks(agentDb.db, repo, { states: ["todo", "ongoing"] }).map((task) => ({
		ref: task.ref,
		goal: task.goal,
		state: task.state,
		...(task.owner.kind === "item" ? { item: task.owner.ref } : {}),
	}));
}

function resourceSnaps(inputs: SourceInputs): ResourceSnap[] {
	const held: ResourceSnap[] = leases.live(inputs.agentDb.db, inputs.root, inputs.now).map((row) => ({
		id: `lease:${String(row.path_key)}`,
		label: `${String(row.path)} (${String(row.reason)})`,
		owner: String(row.owner),
	}));
	const lock = inputs.runLock;
	if (lock)
		held.push({
			id: "full-run",
			label: `full-run: ${lock.label}`,
			owner: lock.agent ?? "unknown",
			...(lock.item === undefined ? {} : { item: lock.item }),
			...(lock.job === undefined ? {} : { job: lock.job }),
			from: "run-lock",
		});
	return held;
}

function waitTarget(kind: string | null, stored: string | null): NodeId | undefined {
	if (!stored || (kind !== "item" && kind !== "agent")) return undefined;
	const parsed = JSON.parse(stored) as { ref?: unknown; name?: unknown };
	if (kind === "agent") return typeof parsed.name === "string" ? nodeId("agent", parsed.name) : undefined;
	return typeof parsed.ref === "string" ? nodeId("item", parsed.ref.split(",")[0] ?? "") : undefined;
}

/** The session's active waits; one that waits for an item or an agent names it, any other (a command, a file) waits for nothing in the graph. */
function waitSnaps(inputs: SourceInputs): WaitSnap[] {
	if (inputs.session === undefined) return [];
	return timers.forSession(inputs.agentDb.db, inputs.session).map((timer) => {
		const target = waitTarget(timer.condition_kind, timer.condition);
		return { id: `#${timer.id}`, label: timer.note, state: timer.status, ...(target ? { on: target } : {}) };
	});
}

/** The snapshots `workGraph` needs, read from the agent database (through its API), the job sources and the run lock. */
export function readGraphSources(inputs: SourceInputs): GraphSources {
	const items = itemSnaps(inputs.store);
	return {
		items,
		steps: stepSnaps(inputs.agentDb, inputs.repo),
		agents: agentSnaps(inputs.agentDb, inputs.repo, items),
		jobs: (inputs.jobs ?? []).flatMap((source) => source()),
		resources: resourceSnaps(inputs),
		waits: waitSnaps(inputs),
	};
}
