import { setImmediate as yieldTurn } from "node:timers/promises";
import type { ArchiveIndexDb } from "../../../../../db/src/api.ts";
import type { Scored } from "../rank/score.ts";
import type { RankFile } from "../rank/scan.ts";
import type { LineRuns } from "../rank/line-runs.ts";
import { rankIndexed } from "./query.ts";
import { openIndex, pruneMissing, syncFiles } from "./sync.ts";

/**
 * The archive index's one owner in a thread: it opens the index file, runs requests one at a time, and lets a ranking
 * cut in on a background sync (which stops between files and runs again after it). It runs in the archive-index worker
 * (`worker-entry.ts`), or on the caller's thread when that worker cannot load.
 */

export type IndexRequest =
	| {
			type: "rank";
			files: RankFile[];
			keywords: string;
			filtered?: Array<[number, LineRuns]>;
			/** Set to nonzero by the caller to cancel. */
			cancel: SharedArrayBuffer;
	  }
	| { type: "sync"; paths: string[]; prune?: boolean; cancel: SharedArrayBuffer };

export class IndexCancelled extends Error {
	constructor() {
		super("The archive index request was cancelled.");
	}
}

/** A background sync gave way to a ranking. */
class Preempted extends Error {}

export class IndexService {
	private index: ArchiveIndexDb | undefined;
	private tail: Promise<unknown> = Promise.resolve();
	private ranksWaiting = 0;
	private readonly file: string;
	/** Yield to the event loop at each check (the caller's thread must keep serving its own work). */
	private readonly yields: boolean;

	constructor(file: string, options: { yields: boolean }) {
		this.file = file;
		this.yields = options.yields;
	}

	run(request: IndexRequest): Promise<Scored | undefined> {
		if (request.type === "rank") this.ranksWaiting++;
		const done = this.tail.then(() => this.execute(request));
		this.tail = done.catch(() => undefined);
		return done;
	}

	private async execute(request: IndexRequest): Promise<Scored | undefined> {
		const flag = new Int32Array(request.cancel);
		const rank = request.type === "rank";
		if (rank) this.ranksWaiting--;
		const check = async () => {
			if (Atomics.load(flag, 0) !== 0) throw new IndexCancelled();
			if (!rank && this.ranksWaiting > 0) throw new Preempted();
			if (this.yields || !rank) await yieldTurn();
		};
		if (Atomics.load(flag, 0) !== 0) throw new IndexCancelled();
		this.index ??= openIndex(this.file);
		if (rank) {
			const filtered = request.filtered ? new Map(request.filtered) : undefined;
			return rankIndexed(this.index, request.files, request.keywords, filtered, check);
		}
		if (!this.index.fts) return undefined;
		try {
			await syncFiles(this.index, request.paths, check);
			if (request.prune) pruneMissing(this.index);
		} catch (error) {
			if (!(error instanceof Preempted)) throw error;
			// Continues after the ranking that cut in.
			void this.run(request).catch(() => undefined);
		}
		return undefined;
	}

	/** Closes the index once the requests already queued are done. */
	async close(): Promise<void> {
		await this.tail;
		this.index?.close();
		this.index = undefined;
	}
}
