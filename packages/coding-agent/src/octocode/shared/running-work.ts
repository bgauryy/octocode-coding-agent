import { createStore } from "zustand/vanilla";
import { ENTITY } from "./entity.ts";
import { plural } from "./text.ts";

/** What the running-work view lists, in the order it groups them. */
export type WorkKind = "agent" | "bash" | "timer" | "external";

const KIND_ORDER: readonly WorkKind[] = ["agent", "bash", "timer", "external"];

/**
 * One item of running work outside the team database: a background bash job, a timer, an external prompt, or a
 * background subagent the team does not list yet. The owner of each kind publishes its rows (`RunningWork.set`);
 * nothing here reads a clock, so a row repaints only when its owner says it changed.
 */
export interface WorkRow {
	kind: WorkKind;
	/** `bash-3`, `#4` (a timer), a subagent's name. */
	id: string;
	/** What the row says first: a bash job's reason or command, what a timer waits for. */
	title: string;
	/** What follows, dim: the command behind a reason, the timer's note. */
	detail?: string;
	/** When it started: its elapsed time is drawn from this. */
	startedAt?: number;
	/** A timer's next wake, or the deadline of one that waits for a condition: its time left is drawn from this. */
	dueAt?: number;
	/** A subagent that waits for prerequisites (`queued`) or is held; it has no clock and the panel draws its own mark. */
	mark?: "queued" | "held";
	/** The backlog item (`B12`) a bash job serves, from the call's `item`. */
	item?: string;
	/** The backlog items (`B12`) a timer's note names; a timer that waits on an item's state names none. */
	items?: readonly string[];
	/** The resource (`full-run`) a bash job holds, from the work graph; the view says `holds full-run`. */
	resource?: string;
}

/** One child queued behind prerequisites, as the panel shows it. */
export interface QueuedWork {
	id: string;
	/** `queued · after B12 (sly-mantle)`, or `held · B12 failed`. */
	title: string;
	held: boolean;
}

const sameRow = (a: WorkRow, b: WorkRow) =>
	a.kind === b.kind &&
	a.id === b.id &&
	a.title === b.title &&
	a.detail === b.detail &&
	a.startedAt === b.startedAt &&
	a.dueAt === b.dueAt &&
	a.mark === b.mark &&
	a.item === b.item &&
	a.resource === b.resource &&
	a.items?.join() === b.items?.join();

interface WorkState {
	byKind: Readonly<Partial<Record<WorkKind, readonly WorkRow[]>>>;
	/** Background subagents this session runs now, by name, whether or not the team lists them yet. */
	background: readonly string[];
	/** The children queued behind prerequisites, a subset of `background`. */
	queued: readonly QueuedWork[];
	/** The agents the footer counts (live team subagents plus unlisted background ones), once a view publishes it. */
	agents: number | undefined;
}

/** Kinds that keep the session busy; a timer only waits to wake it. */
const BUSY_KINDS: readonly WorkKind[] = ["bash", "external"];

/**
 * The rows of every kind that runs now and the background subagents, in one zustand store, and who wants to know when
 * they change. Listeners hear of a change only when something differs.
 */
export class RunningWork {
	private readonly store = createStore<WorkState>()(() => ({
		byKind: {},
		background: [],
		queued: [],
		agents: undefined,
	}));

	private readonly cancellers = new Map<WorkKind, (id: string, ctx: unknown) => boolean>();

	/** The owner of `kind` says how a user ends one of its rows; the function returns false when the row had already ended. */
	onCancel(kind: WorkKind, cancel: (id: string, ctx: unknown) => boolean): void {
		this.cancellers.set(kind, cancel);
	}

	/** Ends the row `id` of `kind` through its owner; undefined when no row of that kind has the id or the kind has no canceller. */
	cancel(kind: WorkKind, id: string, ctx: unknown): boolean | undefined {
		const row = (this.store.getState().byKind[kind] ?? []).find((each) => each.id === id);
		return row ? this.cancellers.get(kind)?.(id, ctx) : undefined;
	}

	/** Replaces the rows of `kind`. */
	set(kind: WorkKind, rows: readonly WorkRow[]): void {
		const { byKind } = this.store.getState();
		const before = byKind[kind] ?? [];
		if (before.length === rows.length && before.every((row, index) => sameRow(row, rows[index]))) return;
		const next = { ...byKind };
		if (rows.length === 0) delete next[kind];
		else next[kind] = rows;
		this.store.setState({ byKind: next });
	}

	/** Replaces the background subagents this session runs now. */
	setBackground(names: readonly string[]): void {
		const before = this.store.getState().background;
		if (before.length === names.length && before.every((name, index) => name === names[index])) return;
		this.store.setState({ background: [...names] });
	}

	/** Replaces the children queued behind prerequisites. */
	setQueued(rows: readonly QueuedWork[]): void {
		const before = this.store.getState().queued;
		if (before.length === rows.length && before.every((row, i) => row.id === rows[i].id && row.title === rows[i].title))
			return;
		this.store.setState({ queued: [...rows] });
	}

	queued(): readonly QueuedWork[] {
		return this.store.getState().queued;
	}

	/** Publishes the agent count the footer shows, so the tab title counts the same agents; `undefined` withdraws it. */
	setAgents(count: number | undefined): void {
		if (this.store.getState().agents === count) return;
		this.store.setState({ agents: count });
	}

	/** The footer's agent count, or `undefined` when no view publishes one. */
	agents(): number | undefined {
		return this.store.getState().agents;
	}

	background(): readonly string[] {
		return this.store.getState().background;
	}

	/** Every row, grouped by kind in `KIND_ORDER`, each group in its owner's order. */
	all(): WorkRow[] {
		const { byKind } = this.store.getState();
		return KIND_ORDER.flatMap((kind) => byKind[kind] ?? []);
	}

	/** How many things still work after the main run settled: background subagents, bash jobs, external work. */
	busy(): number {
		const { byKind, background } = this.store.getState();
		return background.length + BUSY_KINDS.reduce((sum, kind) => sum + (byKind[kind]?.length ?? 0), 0);
	}

	subscribe(listener: () => void): () => void {
		return this.store.subscribe(() => listener());
	}
}

/** One store per feature instance, so the bash, timer and agent features of a session meet in the same view without a shared global. */
const stores = new WeakMap<object, RunningWork>();
export function runningWorkOf(owner: object): RunningWork {
	let store = stores.get(owner);
	if (!store) {
		store = new RunningWork();
		stores.set(owner, store);
	}
	return store;
}

/**
 * The footer's typed counts, `2 agents · 1 bash · 1 wait`; empty when nothing runs. `agents` is the team's live
 * subagents of this session plus background ones it does not list yet.
 */
export function workCounts(agents: number, rows: readonly WorkRow[], queued = 0): string {
	const count = (kind: WorkKind) => rows.filter((row) => row.kind === kind).length;
	const [bash, waits, external] = [count("bash"), count("timer"), count("external")];
	return [
		...(agents > 0 ? [`${ENTITY.subagent} ${plural(agents, "agent")}`] : []),
		...(queued > 0 ? [`${queued} queued`] : []),
		...(bash > 0 ? [`${bash} bash`] : []),
		...(waits > 0 ? [plural(waits, "wait")] : []),
		...(external > 0 ? [`${external} external`] : []),
	].join(" · ");
}
