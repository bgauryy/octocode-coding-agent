import { processAlive } from "../shared/process.ts";
import type { AgentLifecycleBus, LifecycleEvent } from "./lifecycle-bus.ts";

/** What the notices need of the team: its bus, this agent's name, its database and a way to tell it. */
export interface PeerNoticeHost {
	bus: AgentLifecycleBus;
	/** This agent's name while it is in the team. */
	self: () => string | undefined;
	db: () =>
		| { correspondence(me: string, other: string, since?: number): { exchanged: boolean; dead: boolean } }
		| undefined;
	mail: { notice(text: string): boolean };
}

/**
 * Tells an agent that a peer it corresponded with has ended: one line, `<agent> ended: <reason>`, when the
 * peer's AgentOff is heard. A correspondent is one this agent sent mail to or received mail from; the line is an FYI that
 * starts no turn. When mail this agent sent that peer went unread or unanswered, its dead-letter notice is the one notice
 * (`Mail.reportDeadLetters`), so no line. A subagent's parent hears its children's ends in their reports, so those get none.
 * A `crashed` end of a process that still runs was a wrong verdict, not an end: the peer registers again with its next
 * heartbeat, so no line (every wrong retirement of one process would otherwise be announced again).
 */
export class PeerNotices {
	private unwatch: (() => void) | undefined;

	private readonly host: PeerNoticeHost;

	constructor(host: PeerNoticeHost) {
		this.host = host;
	}

	/** Starts listening (idempotent). */
	watch(): void {
		this.unwatch ??= this.host.bus.on((event) => this.heard(event));
	}

	/** Stops listening. */
	stop(): void {
		this.unwatch?.();
		this.unwatch = undefined;
	}

	private heard(event: LifecycleEvent): void {
		const me = this.host.self();
		const db = this.host.db();
		if (event.kind !== "off" || !me || !db || event.agent === me || event.parent === me) return;
		if (event.reason === "crashed" && processAlive(event.stats?.pid)) return;
		const joined = typeof event.stats?.joinedAt === "number" ? event.stats.joinedAt : 0;
		const { exchanged, dead } = db.correspondence(me, event.agent, joined);
		if (!exchanged || dead) return;
		this.host.mail.notice(`${event.agent} ended: ${event.reason ?? "left"}`);
	}
}
