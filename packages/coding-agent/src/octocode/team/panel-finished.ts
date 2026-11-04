import type { Member } from "@octocodeai/octocode-contracts/team";
import { FINISHED_MS, type Finished } from "./panel-compact.ts";
import type { AgentEnd } from "./panel-state.ts";

export type { AgentEnd };

/**
 * Remembers this session's subagents that left the team (a finished child removes its own row), so the panel can keep a
 * `left` row (or its outcome, once the host reports one) for `FINISHED_MS`. An agent that went silent first (killed, hung) was already out of `live` and is not remembered.
 */
export class FinishedTracker {
	private self: string | undefined;
	private lastLive = new Map<string, Member>();
	private readonly gone = new Map<string, Finished>();
	/** Outcomes the host reported, by agent: they may arrive before or after the row leaves the team. */
	private readonly ends = new Map<string, { end: AgentEnd; at: number }>();

	/** `members` is the whole team view; `live` the part of it that is this session's live subagents. */
	update(self: string | undefined, members: Member[], live: Member[], now: number): void {
		if (self !== this.self) this.clear(self);
		const present = new Set(members.map((member) => member.id));
		for (const [id, member] of this.lastLive) if (!present.has(id)) this.gone.set(id, { member, at: now });
		for (const [id, entry] of this.gone) if (now - entry.at > FINISHED_MS || present.has(id)) this.gone.delete(id);
		for (const [id, entry] of this.ends) if (now - entry.at > 2 * FINISHED_MS || present.has(id)) this.ends.delete(id);
		this.lastLive = new Map(live.map((member) => [member.id, member]));
	}

	/** The host learned how agent `id`'s run ended. */
	noteEnd(id: string, end: AgentEnd, now: number): void {
		this.ends.set(id, { end, at: now });
	}

	clear(self?: string): void {
		this.self = self;
		this.lastLive.clear();
		this.gone.clear();
		this.ends.clear();
	}

	get finished(): Finished[] {
		return [...this.gone.entries()].map(([id, entry]) => {
			const known = this.ends.get(id);
			return known ? { ...entry, end: known.end } : entry;
		});
	}
}
