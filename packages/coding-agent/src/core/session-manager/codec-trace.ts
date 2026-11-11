import type { RequestLayer, RequestTrace } from "@octocodeai/octocode-ai";

/**
 * A request trace lists every layer of the request it describes, so storing each whole grows with the square of the
 * turn count. On disk a trace is stored against an earlier one in the same file: `base` names the assistant entry whose
 * trace shares the longest prefix, `keep` how many of its layers this one starts with, and `layers` only the layers
 * after them. A trace with no shared prefix is stored whole. Reading rebuilds the whole trace.
 */
interface StoredTraceDelta {
	base: string;
	keep: number;
	layers: RequestLayer[];
	cacheMode?: string;
}

/** How many of the newest traces in the file are tried as the base of the next one. */
const BASE_CANDIDATES = 8;

function sameLayer(left: RequestLayer, right: RequestLayer): boolean {
	return (
		left.kind === right.kind &&
		left.role === right.role &&
		left.index === right.index &&
		left.chars === right.chars &&
		left.hash === right.hash &&
		left.breakpoint === right.breakpoint &&
		left.ttl === right.ttl
	);
}

function sharedPrefix(left: readonly RequestLayer[], right: readonly RequestLayer[]): number {
	const most = Math.min(left.length, right.length);
	let count = 0;
	while (count < most && sameLayer(left[count], right[count])) count++;
	return count;
}

export function isTraceDelta(value: unknown): value is StoredTraceDelta {
	const record = value as Partial<StoredTraceDelta> | null;
	return (
		typeof record === "object" &&
		record !== null &&
		typeof record.base === "string" &&
		typeof record.keep === "number" &&
		Array.isArray(record.layers)
	);
}

/** The traces of one file in file order, by the id of the assistant entry that holds each. */
export class TraceIndex {
	private readonly byEntry = new Map<string, RequestLayer[]>();
	private readonly recent: string[] = [];

	/** Remember the whole trace of an entry the file now holds. */
	add(entryId: string, trace: RequestTrace): void {
		if (!Array.isArray(trace.layers)) return;
		this.byEntry.set(entryId, trace.layers);
		this.recent.push(entryId);
		if (this.recent.length > BASE_CANDIDATES) this.recent.shift();
	}

	/** The stored form of `trace`: a delta against the earlier trace sharing the longest prefix, else the trace itself. */
	encode(trace: RequestTrace): RequestTrace | StoredTraceDelta {
		if (!Array.isArray(trace.layers) || isTraceDelta(trace)) return trace;
		let best: { id: string; keep: number } | undefined;
		for (let i = this.recent.length - 1; i >= 0; i--) {
			const id = this.recent[i];
			const keep = sharedPrefix(this.byEntry.get(id) ?? [], trace.layers);
			if (keep > (best?.keep ?? 0)) best = { id, keep };
		}
		if (!best) return trace;
		const { layers, ...rest } = trace;
		const delta: StoredTraceDelta = { base: best.id, keep: best.keep, ...rest, layers: layers.slice(best.keep) };
		// Stored only when it reads back byte for byte: a trace with fields this format does not expect stays whole.
		const decoded = this.decode(delta);
		return decoded && JSON.stringify(decoded) === JSON.stringify(trace) ? delta : trace;
	}

	/** The whole trace of a stored delta, or undefined when its base is not an earlier trace of this file. */
	decode(stored: StoredTraceDelta): RequestTrace | undefined {
		const base = this.byEntry.get(stored.base);
		if (!base || stored.keep > base.length) return undefined;
		const { base: _base, keep, layers, ...rest } = stored;
		return { layers: [...base.slice(0, keep), ...layers], ...rest };
	}
}
