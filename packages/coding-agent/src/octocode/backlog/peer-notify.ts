import { renderPrompt } from "../../core/prompt-template.ts";
import type { BacklogChange } from "../shared/backlog-change.ts";
import type { BusEvent } from "./bus.ts";
import { claimsPaths, type Related, type RelatedView, related } from "./related.ts";

/** The customType of the hidden message a peer wake carries. */
export const BACKLOG_PEER_TYPE = "backlog-peer";
/** At most one wake per item in this window; a later change in it is an FYI. */
export const PEER_WAKE_WINDOW_MS = 5 * 60_000;
/** FYI lines one turn names; the rest are counted. */
const MAX_FYI = 3;
/** FYI lines kept for a turn that has not come; older ones are dropped. */
const MAX_KEPT = 50;

/** One wake the notifier asks for: the facts, and the event the gate lists. */
export interface PeerWake {
	ref: string;
	kind: BacklogChange["kind"];
	by: string;
	relation: Related["relation"];
	/** The audit row of the change: wakes of one change are one event. */
	id: number;
	content: string;
}

/** What the notifier needs of this session and its surroundings. */
export interface PeerHost {
	/** This session's id, and its team id (a reservation names the agent). */
	me(): { session: string; agent?: string };
	/** The board, waits and reservations now. */
	view(): RelatedView;
	/** Whether an overlapping claim wakes (`subagents.peerOverlapWake`); off, it is an FYI. */
	overlapWake(): boolean;
	/** Whether this session's last run wrote `ref`: nothing is said about what it just did itself. */
	acted(ref: string): boolean;
	wake(wake: PeerWake): void;
	now(): number;
}

const fact = (related: Related, change: BacklogChange): string =>
	renderPrompt(`notices/peer/${related.relation}.md`, {
		ref: change.ref,
		kind: change.kind,
		by: change.by,
		other: related.ref,
		paths: (related.paths ?? []).join(", "),
	}).trim();

/** Whether a related agent is woken by this change: it unblocks them, or two agents are about to work on the same paths. */
function wakes(related: Related, change: BacklogChange, overlapWake: boolean): boolean {
	const ended = change.kind === "done" || change.kind === "closed";
	if (related.relation === "dependent" || related.relation === "watcher") return ended;
	if (related.relation === "overlap" || related.relation === "reservation") return overlapWake && claimsPaths(change);
	return false;
}

/**
 * Tells this session of changes to items related to the ones it holds or waits on, from the bus's changes: a prerequisite
 * ended wakes the holders of its dependents and the watchers; an overlapping claim (or a claim over reserved paths) wakes
 * the holder once, unless the setting is off; everything else (epic siblings, a note a watcher waits on) waits for the
 * next turn as an FYI. A wake needs 5 minutes since the last one about the same item. Nothing is said of the session's
 * own writes, of an item its last run wrote, or to anyone but the one holding the related item.
 */
export class PeerNotifier {
	private readonly host: PeerHost;
	private readonly lastWake = new Map<string, number>();
	private readonly told = new Set<string>();
	private fyiLines: string[] = [];

	constructor(host: PeerHost) {
		this.host = host;
	}

	/** One bus event: a change by another agent, with the related agents this session is among. */
	handle(event: BusEvent): void {
		if (event.type !== "change" || event.own) return;
		const { change } = event;
		const me = this.host.me();
		const mine = related(change, this.host.view()).filter(
			(each) => each.session === me.session || (me.agent !== undefined && each.agent === me.agent),
		);
		if (mine.length === 0) return;
		const overlapWake = this.host.overlapWake();
		const now = this.host.now();
		const waking: Related[] = [];
		const quiet: Related[] = [];
		for (const each of mine)
			(wakes(each, change, overlapWake) && !this.host.acted(change.ref) ? waking : quiet).push(each);
		const fresh = waking.filter((each) => {
			if (each.relation !== "overlap" && each.relation !== "reservation") return true;
			const pair = `${change.ref}|${each.ref}|${each.session ?? each.agent}`;
			if (this.told.has(pair)) return false;
			this.told.add(pair);
			return true;
		});
		const last = this.lastWake.get(change.ref);
		const paced = last !== undefined && now - last < PEER_WAKE_WINDOW_MS;
		if (fresh.length === 0 || paced) {
			for (const each of fresh) quiet.push(each);
			for (const each of quiet) this.fyiLines.push(fact(each, change));
			return;
		}
		for (const each of quiet) this.fyiLines.push(fact(each, change));
		this.lastWake.set(change.ref, now);
		this.host.wake({
			ref: change.ref,
			kind: change.kind,
			by: change.by,
			relation: fresh[0].relation,
			id: change.id,
			content: renderPrompt("notices/peer/notice.md", { facts: fresh.map((each) => fact(each, change)).join("\n") }),
		});
	}

	/** The FYI lines for the next turn (the oldest few, then a count), and forgets them. */
	fyi(): string | undefined {
		const lines = [...new Set(this.fyiLines)].slice(-MAX_KEPT);
		this.fyiLines = [];
		if (lines.length === 0) return undefined;
		const shown = lines.slice(0, MAX_FYI);
		if (lines.length > MAX_FYI) shown.push(`${lines.length - MAX_FYI} more`);
		return renderPrompt("notices/peer/notice.md", { facts: shown.join("\n") });
	}
}
