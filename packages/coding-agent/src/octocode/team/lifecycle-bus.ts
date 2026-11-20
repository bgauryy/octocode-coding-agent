import type { agentEvents } from "../../../../db/src/api.ts";

/** One presence transition of an agent, derived from an `agent_events` row (never written separately, so it cannot disagree with the audit). */
export interface LifecycleEvent {
	/** The event's sequence in `agent_events`: the cursor. */
	seq: number;
	/** `on`: the agent joined; `state`: its record changed (a `state` of `stalled`, or `changes` of its goal, model…); `off`: its row was retired. */
	kind: "on" | "state" | "off";
	/** The agent's name, role and parent. */
	agent: string;
	role: string | undefined;
	parent: string | null;
	sessionId: string | null;
	workspace: string;
	registrationId: string | undefined;
	time: string;
	/** Whether this process wrote the event itself: only the writer acts on it (a hook runs once per transition). */
	own: boolean;
	state?: string;
	/** `off` only: why (`agentEvents.END_REASONS`), and the free text beside it. */
	reason?: string;
	detail?: string;
	/** `off` only: the row's final numbers, as the delete event stored them. */
	stats?: Record<string, unknown>;
	/** The whole stored payload, for fields this type does not name. */
	data: Record<string, unknown>;
}

const KIND = { create: "on", update: "state", delete: "off" } as const;
const STATS = [
	"startedAt",
	"joinedAt",
	"seenAt",
	"status",
	"toolCalls",
	"input",
	"cacheRead",
	"cacheWrite",
	"output",
	"cost",
	"unpriced",
	"pid",
];
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The transition a stored presence event records. */
function lifecycleEvent(row: agentEvents.EventRow, own = false): LifecycleEvent {
	const kind = KIND[row.type as keyof typeof KIND];
	const { data } = row;
	return {
		seq: row.seq,
		kind,
		agent: row.name ?? text(data.agentId) ?? "",
		role: text(data.role),
		parent: row.parentId,
		sessionId: row.sessionId,
		workspace: row.workspace,
		registrationId: text(data.registrationId),
		time: row.time,
		own,
		...(text(data.state) ? { state: text(data.state)! } : {}),
		...(kind === "state" && text(data.detail) ? { detail: text(data.detail)! } : {}),
		...(kind === "off"
			? {
					reason: text(data.reason) ?? "left",
					...(text(data.detail) ? { detail: text(data.detail)! } : {}),
					stats: Object.fromEntries(STATS.filter((key) => key in data).map((key) => [key, data[key]])),
				}
			: {}),
		data,
	};
}

/** What the bus reads from the database and tells the ticker. */
interface BusHost {
	/** The newest event sequence now (0 with no database): where a first listener starts. */
	head(): number;
	/** Presence events after `after`, oldest first. */
	since(after: number): agentEvents.EventRow[];
	/** The first listener arrived or the last left: the ticker starts or stops following the database. */
	sync(): void;
}

/**
 * The in-process half of the agent lifecycle: listeners hear every join, state change and end of every agent
 * of the shared database, whichever process wrote it. The durable half is `agent_events`: the ticker calls `poll` only when
 * the database file changed, and `poll` reads the events after its cursor, so nothing is queried while nothing changes.
 */
export class AgentLifecycleBus {
	private readonly listeners = new Map<(event: LifecycleEvent) => void, boolean>();
	private cursor: number | undefined;
	/** Sequence ranges this process wrote (inclusive), until the poll that passes them. */
	private own: Array<[number, number]> = [];
	private readonly host: BusHost;

	constructor(host: BusHost) {
		this.host = host;
	}

	/** Whether anyone listens. */
	get listening(): boolean {
		return this.listeners.size > 0;
	}

	/** Whether anyone listens for other processes' transitions: only then does the ticker follow the database file. */
	get following(): boolean {
		return [...this.listeners.values()].some(Boolean);
	}

	/**
	 * Calls `listener` for every transition from now on, until the returned function is called. With `others: false` it hears
	 * only what this process wrote itself, and the database file is not followed for it.
	 */
	on(listener: (event: LifecycleEvent) => void, { others = true } = {}): () => void {
		this.cursor ??= this.host.head();
		this.listeners.set(listener, others);
		this.host.sync();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.cursor = undefined;
			this.host.sync();
		};
	}

	/** This process's own transaction wrote events `from` to `to`. */
	wrote(from: number, to: number): void {
		if (this.listening) this.own.push([from, to]);
	}

	/** Reads the events after the cursor and emits each one; a listener that throws does not stop the others. */
	poll(): void {
		if (this.cursor === undefined) return;
		for (;;) {
			const rows = this.host.since(this.cursor);
			if (rows.length === 0) break;
			this.cursor = rows[rows.length - 1].seq;
			for (const row of rows)
				this.emit(
					lifecycleEvent(
						row,
						this.own.some(([from, to]) => row.seq >= from && row.seq <= to),
					),
				);
			if (rows.length < 200) break;
		}
		this.own = this.own.filter(([, to]) => to > (this.cursor ?? 0));
	}

	private emit(event: LifecycleEvent): void {
		for (const [listener, others] of this.listeners) {
			if (!event.own && !others) continue;
			try {
				listener(event);
			} catch {
				// A listener's failure is its own: the others still hear the transition and the cursor still moves.
			}
		}
	}
}
