import { storedText } from "../../shared/sanitize.ts";
import { addReply, emptyTotals, type UsageTotals } from "../../shared/util.ts";
import { type HeldLeases, LEASE_IDLE_MS } from "../held.ts";
import { LINE_MAX } from "../identity.ts";
import type { Mail } from "../mail.ts";
import type { Member } from "@octocodeai/octocode-contacts/team";
import type { TeamStore } from "../store.ts";

/** Refresh the agent's row at least this often so peers can tell it is alive (and its leases stay valid). */
export const HEARTBEAT_MS = 5_000;

/** What activity accounting reads of the team (`Team`, `session.ts`): the current values each time. */
interface ActivityHost {
	me(): Member | undefined;
	/** The open database, which `flush` writes to unless given another. */
	db(): TeamStore | undefined;
	readonly held: Pick<HeldLeases, "holding" | "lost">;
	readonly mail: Pick<Mail, "notice">;
}

/** This agent's row as it works: status, tool counts and usage change in memory and reach the database on the heartbeat. */
export class Activity {
	private readonly host: ActivityHost;
	/** A status or goal change waits for the next tick; activity, tool counts and usage ride the heartbeat. */
	private statusChanged = false;
	private savedAt = 0;
	/** When this agent last worked (or joined): an idle owner's reservations lapse `LEASE_IDLE_MS` (`held.ts`) after it. */
	private activeAt = 0;
	/**
	 * Replies of this session that finished before it joined (a resumed session's first reply can end before the join):
	 * they belong to this agent's row too, so the panel and `coordinate list` add them on join.
	 */
	private early: { usage: UsageTotals; model?: string } = { usage: emptyTotals() };

	constructor(host: ActivityHost) {
		this.host = host;
	}

	/** A new session starts with no replies counted before its join. */
	resetEarly(): void {
		this.early = { usage: emptyTotals() };
	}

	/** The agent just joined as `me`: it counts as active from its join and takes the replies counted before it. */
	joined(me: Member): void {
		this.activeAt = me.joinedAt;
		this.takeEarlyUsage(me);
	}

	/** One reply's usage; `model` wrote it (it changes when the user switches models); `unpriced`: that model has no pricing. */
	onUsage(usage: unknown, model: string | undefined, unpriced: boolean): void {
		if (!this.host.me()) {
			if (model) this.early.model = storedText(model, LINE_MAX);
			addReply(this.early.usage, usage, unpriced);
			return;
		}
		this.update((me) => {
			if (model) me.model = storedText(model, LINE_MAX);
			addReply(me, usage, unpriced);
		});
	}

	/** Moves the replies counted before the join onto the new row. */
	private takeEarlyUsage(me: Member): void {
		const { usage, model } = this.early;
		me.input += usage.input;
		me.cacheRead += usage.cacheRead;
		me.output += usage.output;
		me.cost += usage.cost;
		if (usage.unpriced) me.unpriced = true;
		if (model) me.model = model;
		this.early = { usage: emptyTotals() };
	}

	/** Changes this agent's row in memory; `status` changes are written on the next tick, the rest with the heartbeat. */
	update(change: (me: Member) => void, status = false): void {
		const me = this.host.me();
		if (!me) return;
		change(me);
		if (status) this.statusChanged = true;
	}

	flush(db: TeamStore | undefined = this.host.db()): void {
		const me = this.host.me();
		if (!me || !db) return;
		const now = Date.now();
		me.updatedAt = now;
		if (me.status === "working") this.activeAt = now;
		if (!db.save(me))
			throw new Error(`The team name ${me.id} is held by another running agent; this agent's row cannot be refreshed.`);
		// Reservations live while their owner works; an idle owner's lapse once it has been idle too long.
		const idle = now - this.activeAt >= LEASE_IDLE_MS;
		if (!idle) db.renew(me.id, now);
		this.savedAt = now;
		this.statusChanged = false;
		if (!this.host.held.holding) return;
		// A heartbeat stall can let a lease lapse (and a peer take the path): say so once, and refuse edits until re-locked.
		const lost = this.host.held.lost(db.owned(me.id, now));
		const why = idle ? ` after ${Math.round((now - this.activeAt) / 60_000)}m idle` : "";
		if (lost.length > 0)
			this.host.mail.notice(`Your reservation on ${lost.join(", ")} lapsed${why}; lock it again before editing.`);
	}

	/** Writes the heartbeat when a status changed or `HEARTBEAT_MS` passed since the last; whether it did. */
	heartbeat(db: TeamStore): boolean {
		if (!this.statusChanged && Date.now() - this.savedAt < HEARTBEAT_MS) return false;
		this.flush(db);
		return true;
	}
}
