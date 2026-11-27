import { createStore } from "zustand/vanilla";
import { clip, plural } from "./text.ts";
import { named, type WaitNames } from "./phase-names.ts";
import { formatDuration } from "./format.ts";
import { runningWorkOf, type WorkRow } from "./running-work.ts";

/**
 * One deterministic answer to "is this session done?". Each owner publishes the facts it knows (the run, a dialog, the
 * running work, the wakes about to start a turn, the ongoing items); `derivePhase` folds them, and every indicator (turn
 * line, live line, tab title, desktop notice) reads the result instead of deciding from the run alone.
 */

type PhaseState = "blocked" | "working" | "waiting" | "resuming" | "scheduled" | "stopped" | "failed" | "done" | "idle";

/** What the session is doing, from the user's side. The `state` says which fields exist. */
export type SessionPhase =
	| { state: "blocked"; title: string }
	| { state: "working"; activity?: string }
	| { state: "waiting"; agents: number; queued: number; bash: number; external: number; names?: WaitNames }
	| { state: "resuming"; label?: string }
	| { state: "scheduled"; timers: number; id: string; dueAt?: number; label?: string }
	| { state: "stopped"; open: readonly string[] }
	| { state: "failed"; error: string; open?: readonly string[] }
	| { state: "done" }
	| { state: "idle" };

/** A timer the session waits for. */
interface PhaseTimer {
	id: string;
	dueAt?: number;
	/** What it waits for: its note's first line, or its condition. */
	label?: string;
}

/** How the last own run ended; `none` before any run. */
export type PhaseOutcome = { status: "none" | "done" | "aborted" } | { status: "error"; error: string };

/** The running work, as counts. Queued children are counted apart from the ones that run. */
export interface PhaseWork {
	agents: number;
	queued: number;
	bash: number;
	external: number;
	/** The names behind `agents` and `bash`; counts alone where an owner does not publish them. */
	names?: WaitNames;
	timers: readonly PhaseTimer[];
}

export interface PhaseFacts {
	/** The session's own run, with the activity line the host indicator shows. */
	run: { active: boolean; activity?: string };
	/** The title of a dialog that waits for the user (the session's own, or a relayed child approval). */
	dialog: string | undefined;
	work: PhaseWork;
	/** What will start a turn without the user: one label per pending wake. */
	wakes: readonly string[];
	/** Ongoing backlog items this session holds, read when a run settles. */
	openItems: readonly string[];
	outcome: PhaseOutcome;
}

const NO_WORK: PhaseWork = { agents: 0, queued: 0, bash: 0, external: 0, timers: [] };

export const INITIAL_FACTS: PhaseFacts = {
	run: { active: false },
	dialog: undefined,
	work: NO_WORK,
	wakes: [],
	openItems: [],
	outcome: { status: "none" },
};

/** The earliest due time among timers that have one. */
const nextDue = (timers: readonly PhaseTimer[]): PhaseTimer =>
	timers.reduce((best, timer) =>
		timer.dueAt !== undefined && (best.dueAt === undefined || timer.dueAt < best.dueAt) ? timer : best,
	);

/** The phase the facts describe; the first matching state wins, in the order of this function. */
export function derivePhase(facts: PhaseFacts): SessionPhase {
	const { run, dialog, work, wakes, openItems, outcome } = facts;
	if (dialog !== undefined) return { state: "blocked", title: dialog };
	if (run.active) return { state: "working", ...(run.activity ? { activity: run.activity } : {}) };
	if (work.agents + work.queued + work.bash + work.external > 0)
		return {
			state: "waiting",
			agents: work.agents,
			queued: work.queued,
			bash: work.bash,
			external: work.external,
			...(work.names && work.names.agents.length + work.names.bash.length > 0 ? { names: work.names } : {}),
		};
	if (wakes.length > 0) return { state: "resuming", label: wakes[0] };
	if (work.timers.length > 0) {
		const next = nextDue(work.timers);
		return {
			state: "scheduled",
			timers: work.timers.length,
			id: next.id,
			...(next.dueAt === undefined ? {} : { dueAt: next.dueAt }),
			...(next.label ? { label: next.label } : {}),
		};
	}
	// An error outranks open items: the user must see it, and the items it left open ride along.
	if (outcome.status === "error")
		return { state: "failed", error: outcome.error, ...(openItems.length > 0 ? { open: openItems } : {}) };
	if (openItems.length > 0) return { state: "stopped", open: openItems };
	if (outcome.status === "done") return { state: "done" };
	return { state: "idle" };
}

const TERMINAL: ReadonlySet<PhaseState> = new Set(["failed", "stopped", "done", "idle"]);

/** Nothing runs, nothing is due and nothing will start a turn: the job is over. */
export function isTerminalPhase(phase: SessionPhase): boolean {
	return TERMINAL.has(phase.state);
}

/** The phases a live line shows while no own run does. */
export function isPendingPhase(phase: SessionPhase): boolean {
	return phase.state === "waiting" || phase.state === "resuming" || phase.state === "scheduled";
}

/** The words of a phase without its mark, or undefined where the phase has none (`working` shows the host's activity line, `done` the turn line). */
export function phaseWords(phase: SessionPhase, now: number): string | undefined {
	switch (phase.state) {
		case "blocked":
			return `Waiting for you: ${phase.title}`;
		case "working":
			return phase.activity;
		case "waiting": {
			const parts = [
				...(phase.agents > 0 ? [named(plural(phase.agents, "agent"), phase.names?.agents)] : []),
				...(phase.queued > 0 ? [`${phase.queued} queued`] : []),
				...(phase.bash > 0 ? [named(`${phase.bash} bash`, phase.names?.bash)] : []),
				...(phase.external > 0 ? [`${phase.external} external`] : []),
			];
			return `Waiting on ${parts.join(" · ")}`;
		}
		case "resuming":
			return phase.label ? `Resuming: ${phase.label}` : "Resuming";
		case "scheduled": {
			const what = phase.timers > 1 ? `${phase.timers} timers` : `timer ${phase.id}`;
			const label = phase.label ? `${clip(phase.label, 60)} · ` : "";
			const left = phase.dueAt === undefined ? "" : ` · in ${formatDuration(Math.max(0, phase.dueAt - now))}`;
			return `Waiting for ${label}${what}${left}`;
		}
		case "stopped":
			return `Stopped · ${phase.open.join(", ")} still open`;
		case "failed":
			return phase.open?.length ? `${phase.error} · ${phase.open.join(", ")} still open` : phase.error;
		case "done":
		case "idle":
			return undefined;
	}
}

/** How a job ended: from the first own run start to the first moment the phase was terminal with no own run. */
export interface JobEnd {
	phase: SessionPhase;
	startedAt: number;
	endedAt: number;
	/** Time the session's own runs took. */
	workedMs: number;
	/** The rest of the job: time with no own run. */
	waitedMs: number;
}

type PhaseListener = (phase: SessionPhase, previous: SessionPhase) => void;

/**
 * The facts of one session and the phase they derive, held in a zustand store like `RunningWork`. Owners publish through
 * the setters; a subscriber hears a change only when the derived phase differs. `now` stamps job boundaries only (a derived phase never reads a clock).
 */
/** The zustand slice: the facts, and the phase derived from them with its comparison key. */
interface PhaseSlice {
	facts: PhaseFacts;
	phase: SessionPhase;
	key: string;
}

const sliceOf = (facts: PhaseFacts): PhaseSlice => {
	const phase = derivePhase(facts);
	return { facts, phase, key: JSON.stringify(phase) };
};

export class SessionPhaseStore {
	private readonly store = createStore<PhaseSlice>()(() => sliceOf(INITIAL_FACTS));
	private job: { startedAt: number; workedMs: number; segmentAt: number | undefined } | undefined;
	private readonly jobEnds = new Set<(end: JobEnd) => void>();
	/** The wakes each source (`reports`, `gate.held`, `gate.sent`, `retry`) knows of. */
	private readonly sources = new Map<string, readonly string[]>();
	private readonly refreshers = new Map<string, () => void>();
	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** The phase now. */
	phase(): SessionPhase {
		return this.store.getState().phase;
	}

	factsNow(): PhaseFacts {
		return this.store.getState().facts;
	}

	/** When the open job started; undefined while no job is open. */
	jobStartedAt(): number | undefined {
		return this.job?.startedAt;
	}

	/** Calls `listener` when the derived phase changes. Returns the unsubscribe. */
	subscribe(listener: PhaseListener): () => void {
		return this.store.subscribe((next, previous) => {
			if (next.key !== previous.key) listener(next.phase, previous.phase);
		});
	}

	/** Calls `listener` once per job, when it becomes terminal while no own run is active. Returns the unsubscribe. */
	onJobEnd(listener: (end: JobEnd) => void): () => void {
		this.jobEnds.add(listener);
		return () => this.jobEnds.delete(listener);
	}

	/** An owner whose facts can be stale at the moment a run settles (a queue not yet told what the session recorded) registers how to catch up. */
	onRefresh(owner: string, refresh: () => void): void {
		this.refreshers.set(owner, refresh);
	}

	/** Runs every refresh; the feed calls it before it publishes a settled run. */
	refresh(): void {
		for (const refresh of this.refreshers.values()) refresh();
	}

	/** The session's own run starts (or goes on with another segment): a job opens. */
	startRun(activity?: string): void {
		this.apply(() => {
			if (!this.factsNow().run.active) {
				const at = this.now();
				this.job ??= { startedAt: at, workedMs: 0, segmentAt: undefined };
				this.job.segmentAt = at;
			}
			return { ...this.factsNow(), run: { active: true, ...(activity ? { activity } : {}) } };
		});
	}

	/** What the run is doing now, for the `working` words. */
	setActivity(activity: string | undefined): void {
		if (!this.factsNow().run.active || this.factsNow().run.activity === activity) return;
		this.apply(() => {
			return { ...this.factsNow(), run: { active: true, ...(activity ? { activity } : {}) } };
		});
	}

	/** The run ended (no queued message continues it): its outcome and the items still open are facts from now on. */
	settleRun(outcome: PhaseOutcome, openItems: readonly string[]): void {
		this.apply(() => {
			if (this.job && this.job.segmentAt !== undefined) {
				this.job.workedMs += this.now() - this.job.segmentAt;
				this.job.segmentAt = undefined;
			}
			return { ...this.factsNow(), run: { active: false }, outcome, openItems: [...openItems] };
		});
	}

	/** The title of the dialog that waits for the user, or undefined when none does. */
	setDialog(title: string | undefined): void {
		if (this.factsNow().dialog === title) return;
		this.apply(() => {
			return { ...this.factsNow(), dialog: title };
		});
	}

	/** Replaces the work counts. */
	setWork(work: PhaseWork): void {
		const before = this.factsNow().work;
		const same =
			before.agents === work.agents &&
			before.queued === work.queued &&
			before.bash === work.bash &&
			before.external === work.external &&
			JSON.stringify(before.timers) === JSON.stringify(work.timers);
		if (same) return;
		this.apply(() => {
			return { ...this.factsNow(), work };
		});
	}

	/**
	 * Replaces the wakes `source` knows of (no labels withdraws them). A wake counts from its send until the turn it starts
	 * begins, or its send settles without starting one; the source decides when that is.
	 */
	setWakes(source: string, labels: readonly string[]): void {
		const before = this.sources.get(source) ?? [];
		if (before.length === labels.length && before.every((label, index) => label === labels[index])) return;
		this.apply(() => {
			if (labels.length === 0) this.sources.delete(source);
			else this.sources.set(source, [...labels]);
			return { ...this.factsNow(), wakes: this.collectWakes() };
		});
	}

	/** A new session: the run, dialog, outcome, items and job are forgotten; the work and the wake sources belong to their owners. */
	reset(): void {
		this.job = undefined;
		this.apply(() => {
			return {
				...this.factsNow(),
				run: { active: false },
				dialog: undefined,
				openItems: [],
				outcome: { status: "none" },
			};
		});
	}

	private collectWakes(): string[] {
		return [...this.sources.values()].flat();
	}

	/** Stores the facts a change returns (the store tells subscribers when the phase moved), then ends the job if it just ended. */
	private apply(change: () => PhaseFacts): void {
		this.store.setState(sliceOf(change()), true);
		const current = this.phase();
		if (!this.job || this.factsNow().run.active || !isTerminalPhase(current)) return;
		const endedAt = this.now();
		const { startedAt, workedMs } = this.job;
		this.job = undefined;
		const end: JobEnd = {
			phase: current,
			startedAt,
			endedAt,
			workedMs,
			waitedMs: Math.max(0, endedAt - startedAt - workedMs),
		};
		for (const listener of this.jobEnds) listener(end);
	}
}

const stores = new WeakMap<object, SessionPhaseStore>();

/** The rows of `RunningWork` as the phase counts them. */
function workFacts(rows: readonly WorkRow[], background: readonly string[], queuedIds: readonly string[]): PhaseWork {
	const queued = queuedIds.length;
	const count = (kind: WorkRow["kind"]) => rows.filter((row) => row.kind === kind).length;
	return {
		agents: Math.max(0, background.length - queued),
		queued,
		bash: count("bash"),
		external: count("external"),
		names: {
			agents: background.filter((name) => !queuedIds.includes(name)),
			bash: rows.filter((row) => row.kind === "bash").map((row) => row.title),
		},
		timers: rows
			.filter((row) => row.kind === "timer")
			.map((row) => ({
				id: row.id,
				...(row.dueAt === undefined ? {} : { dueAt: row.dueAt }),
				label: row.detail || row.title,
			})),
	};
}

/**
 * The phase store of one feature instance, like `runningWorkOf`: bash, timer, agent, wake and UI features of a session
 * meet in one place without a global. It follows the instance's `RunningWork` from the moment it is created.
 */
export function sessionPhaseOf(owner: object): SessionPhaseStore {
	let store = stores.get(owner);
	if (!store) {
		store = new SessionPhaseStore();
		stores.set(owner, store);
		const created = store;
		const work = runningWorkOf(owner);
		const publish = () =>
			created.setWork(
				workFacts(
					work.all(),
					work.background(),
					work.queued().map((entry) => entry.id),
				),
			);
		work.subscribe(publish);
		publish();
	}
	return store;
}
