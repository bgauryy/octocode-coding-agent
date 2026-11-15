import type { Backlog } from "../backlog/context.ts";
import { graphNotice } from "../backlog/graph-notice.ts";
import type { Item } from "../backlog/item.ts";

/** What the watch needs from the main session. */
interface GraphWatchHost {
	/** The main session's backlog; undefined (or a throw) while it cannot be read. */
	backlog(): Backlog | undefined;
	/** A child of this session was started on `ref`: its report carries the graph line. */
	linked(ref: string): boolean;
	/** Wakes the coordinator with a graph notice (`GraphWake.tell`). */
	tell(notice: string): void;
	/** Calls `poke` whenever another process may have written the shared database (`DatabaseFollower`); returns the unsubscribe. */
	subscribe(poke: () => void): () => void;
}

const UNSTARTED: Item["state"][] = ["backlog", "todo"];

/**
 * Whether a child of this session still works on `ref`, so its report will carry the graph line. A child that ended and
 * left the item open keeps its run-map entry; counting that as linked would silence the outside-completion wake.
 */
export function linkedWhileWorking(
	items: ReadonlyMap<string, string>,
	working: (id: string) => boolean,
	ref: string,
): boolean {
	for (const [id, item] of items) if (item === ref && working(id)) return true;
	return false;
}

/**
 * Decision 2 for changes made outside this process: a prerequisite of an item this session planned (its `sourceSession`)
 * completed or closed by another session, the web board or `/backlog` wakes the coordinator through `GraphWake`, with the
 * line its own update or a child's report would have carried. It follows the shared database only while such an item
 * waits, and reads the backlog only when the database file moved: no polling of its own and no deadline.
 */
export class GraphWatch {
	/** Each planned unstarted item that waits, by ref, with the prerequisites still open at the last read. */
	private waits = new Map<string, string[]>();
	private unsubscribe: (() => void) | undefined;
	private checking: Promise<void> | undefined;
	private dirty = false;
	private generation = 0;
	private stopped = false;

	private readonly host: GraphWatchHost;
	constructor(host: GraphWatchHost) {
		this.host = host;
	}

	/** Reads what waits now, without telling anything: the session started, or the coordinator ended a turn. */
	sync(): void {
		this.generation++;
		this.stopped = false;
		const backlog = this.open();
		this.follow(backlog ? this.read(backlog) : new Map());
	}

	/** The database moved: tells each prerequisite that an outside change completed since the last read, once. */
	check(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.dirty = true;
		const settled = () => {
			this.checking = undefined;
			if (this.dirty && !this.stopped) return this.check();
		};
		this.checking ??= this.scan().then(settled, settled);
		return this.checking;
	}

	private async scan(): Promise<void> {
		while (this.dirty && !this.stopped) {
			this.dirty = false;
			const generation = this.generation;
			const backlog = this.open();
			if (!backlog) return;
			try {
				const now = this.read(backlog);
				const ended = new Set<string>();
				for (const [ref, open] of this.waits) {
					const still = now.get(ref) ?? (unstarted(backlog, ref) ? [] : open);
					for (const prerequisite of open) if (!still.includes(prerequisite)) ended.add(prerequisite);
				}
				const notices: string[] = [];
				for (const ref of ended) {
					if (await this.outside(backlog, ref)) {
						const notice = graphNotice(backlog, ref);
						if (notice) notices.push(notice);
					}
					if (generation !== this.generation) break;
				}
				if (generation !== this.generation) continue;
				this.follow(now);
				if (notices.length) this.host.tell(notices.join("\n"));
			} catch {
				// An unreadable backlog tells nothing; the next change reads it again.
			}
		}
	}

	/** The session ended. */
	stop(): void {
		this.generation++;
		this.stopped = true;
		this.follow(new Map());
	}

	private open(): Backlog | undefined {
		try {
			return this.host.backlog();
		} catch {
			return undefined;
		}
	}

	/** The planned unstarted items that wait, with their open prerequisites: two listings. */
	private read(backlog: Backlog): Map<string, string[]> {
		const planned = backlog.store
			.list({ states: UNSTARTED, blocked: true })
			.items.filter((item) => item.sourceSession === backlog.session && item.type !== "epic");
		const ids = [...new Set(planned.flatMap((item) => item.dependsOn.map((ref) => ref.id)))];
		const done = new Set(
			ids.length
				? backlog.store
						.list({ ids })
						.items.filter((item) => item.state === "done")
						.map((item) => item.ref)
				: [],
		);
		return new Map(
			planned.map((item) => [item.ref, item.dependsOn.map((ref) => ref.id).filter((id) => !done.has(id))]),
		);
	}

	/**
	 * Whether `ref` is done and was ended outside this process: not by this session's own `backlog` tool (its result names
	 * what became ready) and not on an item a child of this session was started on (the report carries the line).
	 */
	private async outside(backlog: Backlog, ref: string): Promise<boolean> {
		if (backlog.store.get(ref)?.state !== "done" || this.host.linked(ref)) return false;
		const actor = (await backlog.store.auditAsync(ref, 1)).at(-1)?.actor;
		if (backlog.store.get(ref)?.state !== "done" || this.host.linked(ref)) return false;
		return !(actor?.id === backlog.session && actor.surface === "tool");
	}

	/** Keeps `waits` and follows the database while anything waits. */
	private follow(waits: Map<string, string[]>): void {
		this.waits = waits;
		if (waits.size > 0 && !this.unsubscribe) this.unsubscribe = this.host.subscribe(() => void this.check());
		if (waits.size === 0 && this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}
}

/** Whether `ref` is still an open, unstarted item: one that left the waiting list because it became ready. */
function unstarted(backlog: Backlog, ref: string): boolean {
	const item = backlog.store.get(ref);
	return item !== undefined && !item.closed && UNSTARTED.includes(item.state);
}
