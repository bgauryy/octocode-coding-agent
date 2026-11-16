import type { AgentChainNotice } from "../shared/agent-chain.ts";
import { publishQueuedItems } from "../shared/queued-items.ts";
import type { QueuedWork } from "../shared/running-work.ts";
import {
	type Prerequisite,
	type ItemStanding,
	type PrerequisiteGate,
	parsePrerequisite,
	prerequisiteName,
} from "./prerequisites.ts";

/** Children one session may keep queued: the queue stays bounded. */
export const MAX_QUEUED = 12;
/** Entries one call's `after` may name. */
const MAX_AFTER = 8;

/** One queued child, as `coordinate list`, the footer and the web board read it. */
export interface QueuedChild {
	id: string;
	role: string;
	goal: string;
	/** The backlog item it will work on, claimed when it starts. */
	item?: string;
	/** What it waits for, by name (`B12`, `agent:sly-mantle`). */
	after: string[];
	/** Why it is held (a prerequisite failed, or its start was refused); undefined while it only waits. */
	held?: string;
	/** It left the queue for a slot: it runs now and no longer waits. */
	started?: boolean;
	/** Starts a held child now, ignoring its prerequisites. */
	release: () => void;
}

/** The queued children of one session, by name: what validates a new `after`, what `coordinate list` shows, what cancels. */
export class ChainQueue {
	private readonly entries = new Map<string, QueuedChild>();
	readonly gate: PrerequisiteGate;
	private readonly emit: (notice: AgentChainNotice) => void;
	private readonly watchers = new Set<() => void>();
	private unpublish: (() => void) | undefined;

	constructor(gate: PrerequisiteGate, emit: (notice: AgentChainNotice) => void) {
		this.gate = gate;
		this.emit = emit;
	}

	/** Children that wait (queued or held); a started one no longer counts. */
	get size(): number {
		return this.waiting().length;
	}

	/** Children still waiting: queued behind prerequisites, or held. */
	waiting(): QueuedChild[] {
		return this.all().filter((entry) => !entry.started);
	}

	/** Calls `listener` when a child is queued, held, released, started or dropped. */
	watch(listener: () => void): () => void {
		this.watchers.add(listener);
		return () => void this.watchers.delete(listener);
	}

	private changed(): void {
		const waiting = this.waiting().length > 0;
		if (waiting && !this.unpublish) this.unpublish = publishQueuedItems(() => this.owners());
		else if (!waiting) {
			this.unpublish?.();
			this.unpublish = undefined;
		}
		for (const listener of this.watchers) listener();
	}

	/** The items waiting children will start, by the child's name. */
	owners(): Map<string, string> {
		return new Map(this.waiting().flatMap((entry): [string, string][] => (entry.item ? [[entry.item, entry.id]] : [])));
	}

	/** The child runs now: it leaves the waiting rows. */
	markStarted(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.started = true;
		this.changed();
	}

	/** A held child is no longer held (the coordinator started it). */
	unhold(id: string): void {
		const entry = this.entries.get(id);
		if (!entry?.held) return;
		delete entry.held;
		this.changed();
	}

	get(id: string): QueuedChild | undefined {
		return this.entries.get(id);
	}

	all(): QueuedChild[] {
		return [...this.entries.values()];
	}

	/** The backlog items queued children will work on: their start is announced, so they need no ready notice. */
	items(): ReadonlySet<string> {
		return new Set([...this.entries.values()].flatMap((entry) => (entry.item ? [entry.item] : [])));
	}

	add(entry: QueuedChild): void {
		this.entries.set(entry.id, entry);
		this.emit({
			kind: "queued",
			agent: entry.id,
			role: entry.role,
			after: entry.after,
			...(entry.item ? { item: entry.item } : {}),
		});
		this.changed();
	}

	/** The child left the queue: it started, or it was cancelled. */
	drop(id: string): void {
		this.entries.delete(id);
		this.changed();
	}

	/** Marks a child held for `why` (the failed prerequisites tell `failed`); false when it already was for that reason. */
	hold(id: string, why: string, failed: readonly string[]): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.held === why) return false;
		entry.held = why;
		this.emit({ kind: "held", agent: id, role: entry.role, after: entry.after, failed: [...failed] });
		this.changed();
		return true;
	}

	/** A child's prerequisites were met. */
	released(id: string, seq: number | undefined): void {
		const entry = this.entries.get(id);
		if (entry)
			this.emit({
				kind: "released",
				agent: id,
				role: entry.role,
				after: entry.after,
				...(seq === undefined ? {} : { seq }),
			});
	}

	/** Starts queued or held child `id` now, without waiting for its prerequisites; the refusal text when none is queued by that name. */
	start(id: string): string | undefined {
		const entry = this.entries.get(id);
		if (!entry) return `${id} is not a queued child.`;
		entry.release();
		return undefined;
	}

	/** The prerequisites `entry` still waits on, by name; all of them once none is known open. */
	private pending(entry: QueuedChild): string[] {
		const open = this.gate.open(entry.after.flatMap((name) => parsePrerequisite(name) ?? []));
		return open.length ? open : entry.after;
	}

	/** The queued and held children for `coordinate list`, one row each, with what they still wait on. */
	rows(): string[] {
		return this.waiting().map((entry) => {
			const on = entry.item ? ` on ${entry.item}` : "";
			return entry.held
				? `${entry.id} held${on}: ${entry.held} (start it with agent resume ${entry.id}, or coordinate stop)`
				: `${entry.id} queued${on} after ${this.pending(entry).join(", ")}`;
		});
	}

	/** The panel's rows for the waiting children; `items` (child name -> item) names who works on an item prerequisite. */
	work(items: ReadonlyMap<string, string>): QueuedWork[] {
		const workingOn = (name: string) => [...items].find(([, ref]) => ref === name)?.[0];
		return this.waiting().map((entry) => ({
			id: entry.id,
			held: entry.held !== undefined,
			title:
				entry.held === undefined
					? `queued · after ${this.pending(entry)
							.map((name) => {
								const by = workingOn(name);
								return by ? `${name} (${by})` : name;
							})
							.join(", ")}`
					: `held · ${entry.held}`,
		}));
	}
}

/** What validating an `after` list reads of this session. */
export interface AfterHost {
	/** The item's standing now; `dependsOn`: its open prerequisites. */
	item(ref: string): { standing: ItemStanding; dependsOn: string[] };
	/** Whether `id` is a live child of this session. */
	liveChild(id: string): boolean;
}

/**
 * Checks the prerequisites a call names (`after`, plus the open `dependsOn` of its `item`) and returns those still open,
 * or throws why the call is refused: an unknown shape, a missing or closed item, an agent that is not this session's
 * child or ended badly, the call's own item, a cycle (through `dependsOn` and the queued `after` edges), or a full queue.
 */
export function openPrerequisites(
	host: AfterHost,
	queue: ChainQueue,
	named: readonly string[],
	item: string | undefined,
	waitsOn: readonly string[],
): Prerequisite[] {
	if (named.length > MAX_AFTER) throw new Error(`after names ${named.length} prerequisites: at most ${MAX_AFTER}.`);
	const wanted = new Map<string, Prerequisite>();
	for (const text of [...named, ...waitsOn]) {
		const prerequisite = parsePrerequisite(text);
		if (!prerequisite)
			throw new Error(`after entry "${text}" is neither a backlog item (B12) nor an agent (agent:<name>).`);
		wanted.set(prerequisiteName(prerequisite), prerequisite);
	}
	for (const [name, prerequisite] of wanted) {
		if (prerequisite.kind === "item") {
			if (prerequisite.ref === item) throw new Error(`${name} is this call's own item: it cannot wait for itself.`);
			const { standing } = host.item(prerequisite.ref);
			if (standing === "missing") throw new Error(`after names ${name}, which does not exist.`);
			if (standing === "closed")
				throw new Error(`after names ${name}, which was closed without completion: it will never be done.`);
			continue;
		}
		const ended = queue.gate.ended(prerequisite.id);
		if (!ended && !host.liveChild(prerequisite.id) && !queue.get(prerequisite.id))
			throw new Error(`after names ${name}, which is not a child this session started.`);
		if (ended && queue.gate.standing(prerequisite).state === "failed")
			throw new Error(
				`after names ${name}, which already ended without success (${ended.reason}${ended.outcome ? `, ${ended.outcome}` : ""}).`,
			);
	}
	const open = [...wanted.values()].filter((each) => queue.gate.standing(each).state === "open");
	if (open.length === 0) return [];
	if (queue.size >= MAX_QUEUED)
		throw new Error(
			`${queue.size} children are already queued: at most ${MAX_QUEUED}. Wait for some to start, or stop one.`,
		);
	if (item) refuseCycle(host, queue, open.map(prerequisiteName), item);
	return open;
}

/** Throws when following what `from` waits on (item dependencies and queued children's `after`) reaches `item`. */
function refuseCycle(host: AfterHost, queue: ChainQueue, from: readonly string[], item: string): void {
	const seen = new Set<string>();
	const stack = [...from];
	while (stack.length > 0) {
		const name = stack.pop()!;
		if (seen.has(name)) continue;
		seen.add(name);
		if (name === item) throw new Error(`Cycle: ${item} would wait for ${from.join(", ")}, which wait on ${item}.`);
		const next: string[] = [];
		const prerequisite = parsePrerequisite(name);
		if (prerequisite?.kind === "item") next.push(...host.item(prerequisite.ref).dependsOn);
		for (const entry of queue.all()) if (entry.item === name || `agent:${entry.id}` === name) next.push(...entry.after);
		stack.push(...next);
	}
}
