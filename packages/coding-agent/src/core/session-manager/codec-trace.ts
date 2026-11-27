import type { RequestLayer, RequestTrace } from "@octocodeai/octocode-ai";
import { chainTrace, extendTrace } from "./trace-chain.ts";

/**
 * A request trace lists every layer of the request it describes, so storing each whole grows with the square of the
 * turn count. On disk a trace is stored against an earlier one in the same file: `base` names the assistant entry whose
 * trace shares the longest prefix, `keep` how many of its layers this one starts with, and `layers` only the layers
 * after them. A trace with no shared prefix is stored whole. Reading gives a chained trace (`trace-chain.ts`): the base's
 * layers are shared, not copied, so a session read back holds each layer about once, as the live session does.
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
		left === right ||
		(left.kind === right.kind &&
			left.role === right.role &&
			left.index === right.index &&
			left.chars === right.chars &&
			left.hash === right.hash &&
			left.breakpoint === right.breakpoint &&
			left.ttl === right.ttl)
	);
}

/** Whether `layers` starts with the first `keep` layers of `base` themselves (shared objects, as a chained trace has them). */
function sharesPrefix(layers: readonly RequestLayer[], base: readonly RequestLayer[], keep: number): boolean {
	for (let i = 0; i < keep; i++) if (layers[i] !== base[i]) return false;
	return true;
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
	/** Each trace itself, not a copy of its layers: a chained trace costs only its own links. */
	private readonly byEntry = new Map<string, RequestTrace>();
	private readonly recent: string[] = [];

	/** Remember the whole trace of an entry the file now holds. */
	add(entryId: string, trace: RequestTrace): void {
		if (!Array.isArray(trace.layers)) return;
		this.byEntry.set(entryId, trace);
		this.recent.push(entryId);
		if (this.recent.length > BASE_CANDIDATES) this.recent.shift();
	}

	/** The newest of the recent traces sharing the longest prefix with `layers`, its layers and that prefix's length. */
	private bestBase(layers: readonly RequestLayer[]): { id: string; layers: RequestLayer[]; keep: number } | undefined {
		let best: { id: string; layers: RequestLayer[]; keep: number } | undefined;
		for (let i = this.recent.length - 1; i >= 0; i--) {
			const id = this.recent[i];
			const base = this.byEntry.get(id)?.layers ?? [];
			const keep = sharedPrefix(base, layers);
			if (keep > (best?.keep ?? 0)) best = { id, layers: base, keep };
		}
		return best;
	}

	/**
	 * The stored form of `trace`: a delta against the earlier trace sharing the longest prefix, else the trace itself.
	 * When a delta is chosen for a trace that holds its own array, its first `keep` layers become the base's own objects,
	 * which are equal to them (the read-back check below proves it), so the live message holds each unchanged layer once.
	 * A chained trace already shares them. A trace is not changed after its message ends, so sharing is safe.
	 */
	encode(trace: RequestTrace): RequestTrace | StoredTraceDelta {
		const layers = trace.layers;
		if (!Array.isArray(layers) || isTraceDelta(trace)) return trace;
		const best = this.bestBase(layers);
		if (!best) return trace;
		const { layers: _layers, ...rest } = trace;
		const delta: StoredTraceDelta = { base: best.id, keep: best.keep, ...rest, layers: layers.slice(best.keep) };
		// A trace of the fields this format knows, in their order, whose prefix is the base's own layers reads back as
		// itself (a live, resumed or already stored one); any other is stored only when it reads back byte for byte, so
		// fields this format does not expect keep a trace whole.
		const known = Object.keys(trace).every((key, i) => key === (i === 0 ? "layers" : "cacheMode"));
		if (known && sharesPrefix(layers, best.layers, best.keep)) return delta;
		const decoded = this.decode(delta);
		if (!decoded || JSON.stringify(decoded) !== JSON.stringify(trace)) return trace;
		// A copy of a resumed trace can still point at the original frozen array.
		if (!Object.isFrozen(layers)) for (let i = 0; i < best.keep; i++) layers[i] = best.layers[i];
		return delta;
	}

	/** The whole trace of a stored delta, or undefined when its base is not an earlier trace of this file. */
	decode(stored: StoredTraceDelta): RequestTrace | undefined {
		const base = this.byEntry.get(stored.base);
		if (!base) return undefined;
		const { base: _base, keep, layers, ...rest } = stored;
		return extendTrace(base, keep, layers, rest);
	}

	/** A whole trace read from the file, as a chained trace sharing its prefix with the recent trace it shares most with. */
	share(trace: RequestTrace): RequestTrace {
		if (!Array.isArray(trace.layers)) return trace;
		const best = this.bestBase(trace.layers);
		return chainTrace(trace, best && this.byEntry.get(best.id));
	}
}
