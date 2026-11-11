import type { Member } from "@octocodeai/octocode-contracts/team";
import { FINISHED_MS, type Finished } from "./compact.ts";
import type { AgentEnd } from "./state.ts";

export type { AgentEnd };

/**
 * Remembers this session's subagents that left the team (a finished child removes its own row), so the panel can keep a
 * `left` row (or its outcome, once the host reports one on the member or through `endOf`) for `FINISHED_MS`. An agent that went silent first (killed, hung) was already out of `live` and is not remembered.
 */
export class FinishedTracker {
	private self: string | undefined;
	private lastLive = new Map<string, Member>();
	private readonly gone = new Map<string, Finished>();
	/** `endOf` asks the host how a child ended once its row is gone; a member row that still carries `outcome` says it itself. */
	private readonly endOf: ((id: string) => AgentEnd | undefined) | undefined;

	constructor(endOf?: (id: string) => AgentEnd | undefined) {
		this.endOf = endOf;
	}

	/** `members` is the whole team view; `live` the part of it that is this session's live subagents. */
	update(self: string | undefined, members: Member[], live: Member[], now: number): void {
		if (self !== this.self) this.clear(self);
		const present = new Set(members.map((member) => member.id));
		for (const [id, member] of this.lastLive) if (!present.has(id)) this.gone.set(id, { member, at: now });
		for (const [id, entry] of this.gone) if (now - entry.at > FINISHED_MS || present.has(id)) this.gone.delete(id);
		this.lastLive = new Map(live.map((member) => [member.id, member]));
	}

	clear(self?: string): void {
		this.self = self;
		this.lastLive.clear();
		this.gone.clear();
	}

	get finished(): Finished[] {
		return [...this.gone.entries()].map(([id, entry]) => {
			const { outcome, headline } = entry.member;
			const end = this.endOf?.(id) ?? (outcome ? { outcome, ...(headline ? { headline } : {}) } : undefined);
			return end ? { ...entry, end } : entry;
		});
	}
}
