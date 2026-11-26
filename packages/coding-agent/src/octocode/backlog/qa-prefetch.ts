import type { FeatureContext } from "../../core/features/index.ts";
import type { Backlog } from "./context.ts";
import type { QaMode, QaReview, QaReviewer } from "./qa-gate.ts";
import { coveredCompletion, requestReview } from "./qa-run.ts";

/** How many reviews of one batch run at once: each is a child on the small tier, so the limit bounds cost and provider load. */
export const QA_PARALLEL = 3;

export interface StartedReviews {
	/** Per entry: its review under way, or undefined when the entry needs none. */
	started: (Promise<QaReview | undefined> | undefined)[];
	/** Stops every review that has not finished: the batch is over. */
	stop(): void;
}

/**
 * Starts the reviews a batch of `done` entries needs, at most `limit` at a time, so the batch's serial writes find them
 * ready. A review never writes: the entries' checks, hooks and writes stay in their order. An entry whose completion
 * cannot be read gets none here; the write path reports it on its own row.
 */
export function startReviews(
	backlog: Backlog,
	entries: readonly { id?: unknown; completion?: unknown }[],
	mode: QaMode,
	review: QaReviewer,
	ctx: FeatureContext,
	signal: AbortSignal | undefined,
	limit = QA_PARALLEL,
): StartedReviews {
	const stopper = new AbortController();
	const joined = signal ? AbortSignal.any([signal, stopper.signal]) : stopper.signal;
	let free = limit;
	const waiting: (() => void)[] = [];
	const take = async () => {
		if (free > 0) free--;
		else await new Promise<void>((resolve) => waiting.push(resolve));
	};
	const give = () => {
		const next = waiting.shift();
		if (next) next();
		else free++;
	};
	const started = entries.map((entry) => {
		const item = typeof entry.id === "string" ? backlog.store.get(entry.id) : undefined;
		if (!item || item.state === "done") return undefined;
		try {
			if (!coveredCompletion(item, entry.completion, mode)) return undefined;
		} catch {
			// An unreadable completion is refused by the entry's own write, with its reason.
			return undefined;
		}
		const run = (async () => {
			await take();
			try {
				joined.throwIfAborted();
				return await requestReview(backlog, item, entry.completion, mode, review, ctx, joined);
			} finally {
				give();
			}
		})();
		// The write path awaits it; one that is never reached (the batch ended first) must not surface as unhandled.
		run.catch(() => undefined);
		return run;
	});
	return { started, stop: () => stopper.abort() };
}
