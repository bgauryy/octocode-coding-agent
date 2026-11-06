import { plural } from "./render/text.ts";

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
}

const sameRow = (a: WorkRow, b: WorkRow) =>
	a.kind === b.kind &&
	a.id === b.id &&
	a.title === b.title &&
	a.detail === b.detail &&
	a.startedAt === b.startedAt &&
	a.dueAt === b.dueAt;

/** The rows of every kind that runs now, and who wants to know when they change. */
export class RunningWork {
	private readonly byKind = new Map<WorkKind, readonly WorkRow[]>();
	private readonly listeners = new Set<() => void>();

	/** Replaces the rows of `kind`; listeners hear of it only when something differs. */
	set(kind: WorkKind, rows: readonly WorkRow[]): void {
		const before = this.byKind.get(kind) ?? [];
		if (before.length === rows.length && before.every((row, index) => sameRow(row, rows[index]))) return;
		if (rows.length === 0) this.byKind.delete(kind);
		else this.byKind.set(kind, rows);
		for (const listener of Array.from(this.listeners)) listener();
	}

	/** Every row, grouped by kind in `KIND_ORDER`, each group in its owner's order. */
	all(): WorkRow[] {
		return KIND_ORDER.flatMap((kind) => this.byKind.get(kind) ?? []);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

/** One store per extension instance, so the bash, timer and agent features of a session meet in the same view without a shared global. */
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
 * The footer's typed counts, `2 agents · 1 bash · 1 timer`; empty when nothing runs. `agents` is the team's live
 * subagents of this session plus background ones it does not list yet.
 */
export function workCounts(agents: number, rows: readonly WorkRow[]): string {
	const count = (kind: WorkKind) => rows.filter((row) => row.kind === kind).length;
	const [bash, timers, external] = [count("bash"), count("timer"), count("external")];
	return [
		...(agents > 0 ? [plural(agents, "agent")] : []),
		...(bash > 0 ? [`${bash} bash`] : []),
		...(timers > 0 ? [plural(timers, "timer")] : []),
		...(external > 0 ? [`${external} external`] : []),
	].join(" · ");
}
