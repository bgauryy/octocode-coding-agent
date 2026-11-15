import type { AgentLifecycleNotice } from "../shared/agent-lifecycle.ts";

/** What a queued child waits for: a backlog item (`B12`) or an agent of this session (`agent:sly-mantle`). */
export type Prerequisite = { kind: "item"; ref: string } | { kind: "agent"; id: string };

const AGENT_PREFIX = "agent:";

/** The prerequisite a text names, or undefined for any other text. */
export function parsePrerequisite(text: string): Prerequisite | undefined {
	const name = text.trim();
	if (/^B\d+$/i.test(name)) return { kind: "item", ref: name.toUpperCase() };
	if (name.startsWith(AGENT_PREFIX) && name.length > AGENT_PREFIX.length)
		return { kind: "agent", id: name.slice(AGENT_PREFIX.length) };
	return undefined;
}

/** The text a call, a notice or a row names the prerequisite by. */
export const prerequisiteName = (prerequisite: Prerequisite): string =>
	prerequisite.kind === "item" ? prerequisite.ref : `${AGENT_PREFIX}${prerequisite.id}`;

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

/** What the gate reads and listens to; the subagents tool supplies it (backlog, `api.events`, the database follower). */
export interface GateHost {
	/** The item's standing now: read on every check, so a missed event never strands a wait. */
	item(ref: string): ItemStanding;
	/** Calls `listener` for every lifecycle transition (`AGENT_LIFECYCLE_CHANNEL`); returns the unsubscribe. */
	lifecycle(listener: (notice: AgentLifecycleNotice) => void): () => void;
	/** Calls `poke` whenever another process may have written the shared database (`DatabaseFollower`); returns the unsubscribe. */
	follow(poke: () => void): () => void;
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
		const end = this.ends.get(prerequisite.id);
		if (!end) return { state: "open" };
		if (end.reason === "completed" && end.outcome === "done")
			return { state: "met", ...(end.seq === undefined ? {} : { seq: end.seq }) };
		const how = end.reason === "completed" ? `reported ${end.outcome ?? "no outcome word"}` : `ended ${end.reason}`;
		return { state: "failed", why: `${prerequisite.id} ${how}` };
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
		if (this.waits.size === 0) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		}
	}

	private listen(): void {
		if (this.unsubscribe) return;
		const stopLifecycle = this.host.lifecycle((notice) => {
			if (notice.kind === "off") {
				// The parent's own record of the run is better than the retired row's: a child's `off` row seldom has the outcome.
				if (this.ends.has(notice.agent)) return this.refresh();
				const outcome = notice.data.outcome;
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
