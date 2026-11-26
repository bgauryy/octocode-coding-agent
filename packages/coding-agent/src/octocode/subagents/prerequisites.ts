import type { JobStanding } from "../shared/job-standing.ts";
import type { AgentLifecycleNotice } from "../shared/agent-lifecycle.ts";

/** The locks a prerequisite can wait on: the host's full test run (`lock:full-run`). */
const LOCKS = ["full-run"] as const;
type LockName = (typeof LOCKS)[number];

/**
 * What a queued child waits for: a backlog item (`B12`), an agent of this session (`agent:sly-mantle`), a background job
 * of this session (`job:bash-3`) or a host lock to be free (`lock:full-run`).
 */
export type Prerequisite =
	| { kind: "item"; ref: string }
	| { kind: "agent"; id: string }
	| { kind: "job"; id: string }
	| { kind: "lock"; name: LockName };

const AGENT_PREFIX = "agent:";
const JOB_PREFIX = "job:";
const LOCK_PREFIX = "lock:";

/** The prerequisite a text names, or undefined for any other text. */
export function parsePrerequisite(text: string): Prerequisite | undefined {
	const name = text.trim();
	const itemMatch = /^(?:item:|#)?(B\d+)$/i.exec(name);
	if (itemMatch) return { kind: "item", ref: itemMatch[1].toUpperCase() };
	if (name.startsWith(AGENT_PREFIX) && name.length > AGENT_PREFIX.length)
		return { kind: "agent", id: name.slice(AGENT_PREFIX.length) };
	if (/^job:bash-\d+$/.test(name)) return { kind: "job", id: name.slice(JOB_PREFIX.length) };
	const lock = name.startsWith(LOCK_PREFIX) ? name.slice(LOCK_PREFIX.length) : undefined;
	const known = LOCKS.find((each) => each === lock);
	if (known) return { kind: "lock", name: known };
	return undefined;
}

/** The text a call, a notice or a row names the prerequisite by. */
export function prerequisiteName(prerequisite: Prerequisite): string {
	if (prerequisite.kind === "item") return prerequisite.ref;
	if (prerequisite.kind === "agent") return `${AGENT_PREFIX}${prerequisite.id}`;
	if (prerequisite.kind === "job") return `${JOB_PREFIX}${prerequisite.id}`;
	return `${LOCK_PREFIX}${prerequisite.name}`;
}

/** Where an item stands for a prerequisite: `closed` is done without a completion; `missing` is deleted or never existed. */
export type ItemStanding = "open" | "done" | "closed" | "missing";

/** How an agent's run ended: the lifecycle end reason, and the outcome word its report led with. */
export interface AgentEnd {
	reason: string;
	outcome?: string | undefined;
	/** The `agent_events` sequence of the transition, when it came from the lifecycle channel. */
	seq?: number | undefined;
}

export type Standing = { state: "open" } | { state: "met"; seq?: number } | { state: "failed"; why: string };

/** What a wait on prerequisites ended with: all met (`seq`: the newest lifecycle event among them), or the ones that failed. */
export type GateResult =
	| { status: "met"; seq?: number }
	| { status: "failed"; failed: Array<{ name: string; why: string }> };

/** What the gate reads and listens to; the subagents tool supplies it (backlog, `api.channels`, the database follower). */
export interface GateHost {
	/** The item's standing now: read on every check, so a missed event never strands a wait. */
	item(ref: string): ItemStanding;
	/** Whether `id` is a child of this session whose report is still being finalized (`noteEnd` will supply its outcome). */
	ownRunning?(id: string): boolean;
	/** Calls `listener` for every lifecycle transition (`AGENT_LIFECYCLE_CHANNEL`); returns the unsubscribe. */
	lifecycle(listener: (notice: AgentLifecycleNotice) => void): () => void;
	/** Calls `poke` whenever another process may have written the shared database (`DatabaseFollower`); returns the unsubscribe. */
	follow(poke: () => void): () => void;
	/** Where background job `id` of this session stands now (a job's end writes the database, which `follow` hears). */
	job?(id: string): JobStanding;
	/** Whether the host lock `name` is held now. */
	lockHeld?(name: LockName): boolean;
	/** Calls `poke` while a wait needs a lock's release, which no database change announces; returns the unsubscribe. */
	watchLocks?(poke: () => void): () => void;
}

/** Ended agents the gate remembers: a queue is bounded, so is what it can refer back to. */
const REMEMBERED_ENDS = 200;

interface Wait {
	prerequisites: Prerequisite[];
	settle: (result: GateResult) => void;
}

/**
 * The open prerequisites of queued children, settled by events and never by polling. An agent prerequisite is met when
 * its run ended `completed` with outcome `done`, and failed on any other end; an item prerequisite is met when the item
 * is done and failed when it was closed without completion or deleted. Standing is read when a wait starts (so an end
 * the gate was not subscribed for still counts) and again on each lifecycle event, each database change and each
 * `refresh` (the parent's own child just reported). The gate listens only while a wait is open.
 */
export class PrerequisiteGate {
	private readonly ends = new Map<string, AgentEnd>();
	private readonly waits = new Set<Wait>();
	private unsubscribe: (() => void) | undefined;
	private stopLocks: (() => void) | undefined;
	private readonly host: GateHost;

	constructor(host: GateHost) {
		this.host = host;
	}

	/** Records how run `id` ended, as its parent saw it (the latest end of the agent wins: a resumed child ends again). */
	noteEnd(id: string, end: AgentEnd): void {
		this.ends.delete(id);
		this.ends.set(id, end);
		if (this.ends.size > REMEMBERED_ENDS) this.ends.delete(this.ends.keys().next().value as string);
		this.refresh();
	}

	/** The end `noteEnd` recorded for agent `id`, if it ended. */
	ended(id: string): AgentEnd | undefined {
		return this.ends.get(id);
	}

	/** Where `prerequisite` stands now. An agent that has not ended is open. */
	standing(prerequisite: Prerequisite): Standing {
		if (prerequisite.kind === "item") {
			const item = this.host.item(prerequisite.ref);
			if (item === "done") return { state: "met" };
			if (item === "closed") return { state: "failed", why: `${prerequisite.ref} was closed without completion` };
			if (item === "missing") return { state: "failed", why: `${prerequisite.ref} no longer exists` };
			return { state: "open" };
		}
		if (prerequisite.kind === "job") return this.jobStanding(prerequisite.id);
		if (prerequisite.kind === "lock") {
			if (!this.host.lockHeld)
				return { state: "failed", why: `this host cannot check ${prerequisiteName(prerequisite)}` };
			return this.host.lockHeld(prerequisite.name) ? { state: "open" } : { state: "met" };
		}
		const end = this.ends.get(prerequisite.id);
		if (!end) return { state: "open" };
		if (end.reason === "completed" && end.outcome === "done")
			return { state: "met", ...(end.seq === undefined ? {} : { seq: end.seq }) };
		const how = end.reason === "completed" ? `reported ${end.outcome ?? "no outcome word"}` : `ended ${end.reason}`;
		return { state: "failed", why: `${prerequisite.id} ${how}` };
	}

	private jobStanding(id: string): Standing {
		if (!this.host.job) return { state: "failed", why: `this host cannot check job:${id}` };
		const job = this.host.job(id);
		if (job.state === "running") return { state: "open" };
		if (job.state === "done") return { state: "met" };
		if (job.state === "failed") return { state: "failed", why: `${id} ${job.why}` };
		return { state: "failed", why: `${id} is not a background job of this session` };
	}

	/** The names among `prerequisites` that are still open. */
	open(prerequisites: readonly Prerequisite[]): string[] {
		return prerequisites.filter((each) => this.standing(each).state === "open").map(prerequisiteName);
	}

	/**
	 * Resolves once every prerequisite is met, or at once when one has failed. `signal` ends the wait with its reason. Holds
	 * nothing while it waits but the gate's own subscription, released with the last wait.
	 */
	wait(prerequisites: readonly Prerequisite[], signal: AbortSignal): Promise<GateResult> {
		signal.throwIfAborted();
		return new Promise<GateResult>((resolve, reject) => {
			const entry: Wait = { prerequisites: [...prerequisites], settle: () => undefined };
			const cancel = () => {
				this.leave(entry);
				reject(signal.reason);
			};
			entry.settle = (result) => {
				signal.removeEventListener("abort", cancel);
				this.leave(entry);
				resolve(result);
			};
			signal.addEventListener("abort", cancel, { once: true });
			const now = this.result(entry);
			if (now) return entry.settle(now);
			this.waits.add(entry);
			this.listen();
			this.syncLocks();
		});
	}

	/** Reads every open wait again: something the gate does not hear of itself changed. */
	refresh(): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- a settled wait leaves the set while it is walked
		for (const entry of [...this.waits]) {
			const result = this.result(entry);
			if (result) entry.settle(result);
		}
	}

	private result({ prerequisites }: Wait): GateResult | undefined {
		const failed: Array<{ name: string; why: string }> = [];
		let seq: number | undefined;
		let open = false;
		for (const each of prerequisites) {
			const standing = this.standing(each);
			if (standing.state === "failed") failed.push({ name: prerequisiteName(each), why: standing.why });
			else if (standing.state === "open") open = true;
			else if (standing.seq !== undefined) seq = Math.max(seq ?? 0, standing.seq);
		}
		if (failed.length > 0) return { status: "failed", failed };
		return open ? undefined : { status: "met", ...(seq === undefined ? {} : { seq }) };
	}

	private leave(entry: Wait): void {
		this.waits.delete(entry);
		this.syncLocks();
		if (this.waits.size === 0) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		}
	}

	/** Watches locks only while an open wait names one. */
	private syncLocks(): void {
		const needed = [...this.waits].some((wait) => wait.prerequisites.some((each) => each.kind === "lock"));
		if (needed && !this.stopLocks && this.host.watchLocks) this.stopLocks = this.host.watchLocks(() => this.refresh());
		if (!needed) {
			this.stopLocks?.();
			this.stopLocks = undefined;
		}
	}

	private listen(): void {
		if (this.unsubscribe) return;
		const stopLifecycle = this.host.lifecycle((notice) => {
			if (notice.kind === "off") {
				// The parent's own record of the run is better than the retired row's: a child's `off` row seldom has the outcome.
				if (this.ends.has(notice.agent)) return this.refresh();
				const outcome = notice.data.outcome;
				if (typeof outcome !== "string" && this.host.ownRunning?.(notice.agent)) return;
				this.noteEnd(notice.agent, {
					reason: notice.reason ?? "left",
					outcome: typeof outcome === "string" ? outcome : undefined,
					seq: notice.seq,
				});
			}
		});
		const stopFollow = this.host.follow(() => this.refresh());
		this.unsubscribe = () => {
			stopLifecycle();
			stopFollow();
		};
	}
}
