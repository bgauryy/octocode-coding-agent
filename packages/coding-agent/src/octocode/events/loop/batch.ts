import { type Batch, type BatchLine, type EventCatalog, type Logged, MAX_BATCH_LINES } from "./types.ts";

/**
 * Builds the one message of a delivery from its entries (RFC §5.1 items 5–7): entries with the same coalescing key become
 * one line with a count; past the cap, sources take turns so one chatty child cannot starve the others; what the cap
 * leaves out is a count and the log range that holds it. Pure: the loop decides when, this decides what.
 */
export function buildBatch<C>(
	catalog: EventCatalog,
	entries: ReadonlyArray<Logged<C>>,
	cap = MAX_BATCH_LINES,
): Batch<C> {
	const ordered = entries.some((entry) => entry.type === "input")
		? [...entries.filter((entry) => entry.type === "input"), ...entries.filter((entry) => entry.type !== "input")]
		: entries.slice();
	// The session sends the original completions. Format digests only for a consumer that reads them.
	let summary: Pick<Batch<C>, "lines" | "more" | "range"> | undefined;
	const read = () => (summary ??= summarize(catalog, ordered, cap));
	return {
		entries: ordered,
		trigger: ordered.some((entry) => entry.type === "input" || entry.wake),
		get lines() {
			return read().lines;
		},
		get more() {
			return read().more;
		},
		get range() {
			return read().range;
		},
	};
}

function summarize<C>(
	catalog: EventCatalog,
	ordered: ReadonlyArray<Logged<C>>,
	cap: number,
): Pick<Batch<C>, "lines" | "more" | "range"> {
	const lines = new Map<string, BatchLine>();
	for (const entry of ordered) {
		if (entry.type !== "event") continue;
		const { label, key } = catalog.describe(entry.event);
		const id = `${entry.event.kind}\u0000${key}`;
		const line = lines.get(id);
		if (line) {
			line.count++;
			line.seqs.push(entry.seq);
		} else {
			lines.set(id, {
				topic: entry.event.kind,
				key,
				digest: label,
				source: entry.source,
				count: 1,
				seqs: [entry.seq],
			});
		}
	}
	const all = [...lines.values()];
	const shown = all.length <= cap ? all : roundRobin(all, cap);
	const visible = new Set(shown);
	let more = 0;
	let from = Infinity;
	let to = -Infinity;
	for (const line of all) {
		if (visible.has(line)) continue;
		more += line.count;
		for (const seq of line.seqs) {
			from = Math.min(from, seq);
			to = Math.max(to, seq);
		}
	}
	return {
		lines: shown,
		more,
		...(more > 0 ? { range: { from, to } } : {}),
	};
}

/** `cap` lines, one source after another in turn (each source's own order kept), shown in arrival order. */
function roundRobin(lines: readonly BatchLine[], cap: number): BatchLine[] {
	const bySource = new Map<string, BatchLine[]>();
	for (const line of lines) {
		const id = `${line.source.kind}:${line.source.id}`;
		const source = bySource.get(id);
		if (source) source.push(line);
		else bySource.set(id, [line]);
	}
	const taken = new Set<BatchLine>();
	const queues = [...bySource.values()];
	for (let round = 0; taken.size < cap; round++) {
		let any = false;
		for (const queue of queues) {
			const line = queue[round];
			if (!line || taken.size >= cap) continue;
			taken.add(line);
			any = true;
		}
		if (!any) break;
	}
	return lines.filter((line) => taken.has(line));
}
