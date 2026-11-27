import type { RequestLayer, RequestTrace } from "@octocodeai/octocode-ai";

/**
 * Consecutive requests of a conversation share all but their last few layers, so a trace that holds its own array of
 * every layer makes a session hold each layer once per later request: memory grows with the square of the request
 * count. A chained trace keeps its layers as the newest link of a list that later traces extend instead. Each link names
 * one layer and the link before it, so a trace costs only the links after the prefix it shares with its base, and a
 * session holds about one link per layer it ever sent.
 *
 * A chained trace is a plain object whose `layers` is an enumerable getter: JSON, spreading and cloning see the array.
 * Reading it rebuilds the array in wire order by walking the trace's own links, which costs its length, not the number
 * of traces before it. The newest rebuilt arrays are kept, so a reader that reads `layers` twice builds it once; they are
 * frozen, as a trace is not changed after its request.
 */

interface Link {
	readonly layer: RequestLayer;
	readonly parent: Link | undefined;
}

interface Chain {
	readonly tip: Link | undefined;
	readonly length: number;
}

const chains = new WeakMap<object, Chain>();

/** How many rebuilt arrays are kept, the least recently read forgotten first: the codec compares a new trace with 8. */
const KEPT_ARRAYS = 16;
const kept = new Map<Chain, readonly RequestLayer[]>();

function layersOf(chain: Chain): RequestLayer[] {
	let layers = kept.get(chain);
	if (layers) kept.delete(chain);
	else {
		const built: RequestLayer[] = [];
		for (let link = chain.tip; link; link = link.parent) built.push(link.layer);
		layers = Object.freeze(built.reverse());
	}
	kept.set(chain, layers);
	if (kept.size > KEPT_ARRAYS) kept.delete(kept.keys().next().value as Chain);
	return layers as RequestLayer[];
}

/** The chain of `base`'s first `keep` layers followed by `tail`. */
function extend(base: Chain | undefined, keep: number, tail: readonly RequestLayer[]): Chain {
	let tip = base?.tip;
	for (let length = base?.length ?? 0; length > keep && tip; length--) tip = tip.parent;
	for (const layer of tail) tip = { layer, parent: tip };
	return { tip, length: keep + tail.length };
}

/** The chain `trace` is a view of; an unchained trace gets links of its own, shared with nothing. */
function chainOf(trace: RequestTrace): Chain {
	return chains.get(trace) ?? extend(undefined, 0, trace.layers);
}

/** A chained trace of `chain` with the other fields of `fields`, keys in their order (`layers` first when absent). */
function view(chain: Chain, fields: object): RequestTrace {
	const keys = Object.keys(fields);
	if (!keys.includes("layers")) keys.unshift("layers");
	const trace: Record<string, unknown> = {};
	for (const key of keys) {
		if (key === "layers") {
			Object.defineProperty(trace, key, { enumerable: true, configurable: true, get: () => layersOf(chain) });
		} else trace[key] = (fields as Record<string, unknown>)[key];
	}
	chains.set(trace, chain);
	return trace as unknown as RequestTrace;
}

/** Same own keys in the same order with the same values: the same JSON. */
function sameFields(left: object, right: object): boolean {
	if (left === right) return true;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every(
		(key, i) =>
			key === rightKeys[i] && (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key],
	);
}

/**
 * `trace` as a chained trace extending `base` (an earlier trace of the same conversation) by the layers after the
 * longest prefix of equal layers they share; those prefix layers become `base`'s own objects. Without `base` the trace
 * starts a chain.
 */
export function chainTrace(trace: RequestTrace, base?: RequestTrace): RequestTrace {
	const layers = trace.layers;
	if (!base) return view(extend(undefined, 0, layers), trace);
	const chain = chainOf(base);
	const before = layersOf(chain);
	const most = Math.min(before.length, layers.length);
	let keep = 0;
	while (keep < most && sameFields(before[keep], layers[keep])) keep++;
	return view(extend(chain, keep, layers.slice(keep)), trace);
}

/**
 * The chained trace of `base`'s first `keep` layers followed by `tail`, with the other fields of `fields`; undefined when
 * `keep` is not a count of `base`'s layers.
 */
export function extendTrace(
	base: RequestTrace,
	keep: number,
	tail: readonly RequestLayer[],
	fields: object,
): RequestTrace | undefined {
	const chain = chainOf(base);
	if (!Number.isInteger(keep) || keep < 0 || keep > chain.length) return undefined;
	return view(extend(chain, keep, tail), fields);
}
