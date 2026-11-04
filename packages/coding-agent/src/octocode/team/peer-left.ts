import type { AgentLifecycleBus, LifecycleEvent } from "./lifecycle-bus.ts";

/** What the notices need of the team: its bus, this agent's name, its database and a way to tell it. */
export interface PeerNoticeHost {
	bus: AgentLifecycleBus;
	/** This agent's name while it is in the team. */
	self: () => string | undefined;
	db: () =>
		| { correspondence(me: string, other: string, since?: number): { exchanged: boolean; asked: boolean } }
		| undefined;
	mail: { peerLeft(text: string, wake: boolean): boolean };
}

/**
 * Tells an agent that a peer it corresponded with has ended (design B36 §7): one line, `<agent> ended: <reason>`, when the
 * peer's AgentOff is heard. A correspondent is one this agent sent mail to or received mail from; the line is an FYI unless a
 * question of this agent's to that peer is still unanswered, which wakes it (the answer is not coming). A subagent's parent
 * hears its children's ends in their reports, so those get no line.
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
		const joined = typeof event.stats?.joinedAt === "number" ? event.stats.joinedAt : 0;
		const { exchanged, asked } = db.correspondence(me, event.agent, joined);
		if (!exchanged && !asked) return;
		this.host.mail.peerLeft(`${event.agent} ended: ${event.reason ?? "left"}`, asked);
	}
}
