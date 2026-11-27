/**
 * Remembers the layers of the last request described with it, so the next request serializes and hashes only the layers
 * whose wire form changed. A conversation grows at its end: every earlier message is the same data again, rebuilt by the
 * adapter as new objects, so object identity cannot tell an unchanged layer. Instead each layer keeps the sequence of
 * values its JSON is made of (keys, primitives, and markers for the start and end of each object or array). Strings are
 * kept by reference, so the snapshot costs a pointer per value and comparing it costs no serialization: two layers with
 * the same sequence have the same JSON, and so the same length and hash.
 *
 * Anything this cannot vouch for (an object that is not a plain object or array, a `toJSON` method, a throwing getter)
 * is measured in full each time, as it is without a memo; a mismatch at any position measures the layer in full. The
 * layer objects of a request are also reused for the next one when every field is equal, so a stored trace that shares
 * a prefix with the previous one shares its objects too (the session file's delta encoding then needs no read-back).
 */

/** A layer's wire length and hash, as `JSON.stringify` and the hash give them. */
export interface MeasuredLayer {
	chars: number;
	hash: string;
}

const OBJECT_START = { token: "{" };
const ARRAY_START = { token: "[" };
const END = { token: "}" };
const NO_MATCH = -1;

/** Values `JSON.stringify` leaves out of an object and writes as `null` in an array. */
const isOmitted = (value: unknown): boolean =>
	value === undefined || typeof value === "function" || typeof value === "symbol";

/** A plain object or array without its own `toJSON`: its JSON is its keys and values, in `Object.keys` order. */
function isPlain(value: object): boolean {
	if (typeof (value as { toJSON?: unknown }).toJSON === "function") return false;
	if (Array.isArray(value)) return true;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Appends to `out` the values `JSON.stringify(value, replacer)` writes, where the replacer drops the keys in `omit`.
 * False when `value` holds data whose JSON this does not reproduce (its own `toJSON`, a class instance).
 */
function record(value: unknown, omit: ReadonlySet<string>, out: unknown[]): boolean {
	if (typeof value !== "object" || value === null) {
		out.push(value);
		return true;
	}
	if (!isPlain(value)) return false;
	if (Array.isArray(value)) {
		out.push(ARRAY_START);
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			if (!record(isOmitted(item) ? null : item, omit, out)) return false;
		}
		out.push(END);
		return true;
	}
	out.push(OBJECT_START);
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields)) {
		const item = fields[key];
		if (omit.has(key) || isOmitted(item)) continue;
		out.push(key);
		if (!record(item, omit, out)) return false;
	}
	out.push(END);
	return true;
}

/** The position after `value` when `tokens` from `at` are what `record` would append for it, else `NO_MATCH`. */
function match(value: unknown, omit: ReadonlySet<string>, tokens: readonly unknown[], at: number): number {
	if (at >= tokens.length) return NO_MATCH;
	if (typeof value !== "object" || value === null) return tokens[at] === value ? at + 1 : NO_MATCH;
	if (!isPlain(value)) return NO_MATCH;
	let position = at + 1;
	if (Array.isArray(value)) {
		if (tokens[at] !== ARRAY_START) return NO_MATCH;
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			position = match(isOmitted(item) ? null : item, omit, tokens, position);
			if (position === NO_MATCH) return NO_MATCH;
		}
	} else {
		if (tokens[at] !== OBJECT_START) return NO_MATCH;
		const fields = value as Record<string, unknown>;
		for (const key of Object.keys(fields)) {
			const item = fields[key];
			if (omit.has(key) || isOmitted(item)) continue;
			if (position >= tokens.length || tokens[position] !== key) return NO_MATCH;
			position = match(item, omit, tokens, position + 1);
			if (position === NO_MATCH) return NO_MATCH;
		}
	}
	return position < tokens.length && tokens[position] === END ? position + 1 : NO_MATCH;
}

interface Slot extends MeasuredLayer {
	kind: string;
	tokens: readonly unknown[];
}

function sameJson(value: unknown, omit: ReadonlySet<string>, tokens: readonly unknown[]): boolean {
	try {
		return match(value, omit, tokens, 0) === tokens.length;
	} catch {
		return false;
	}
}

function snapshot(kind: string, value: unknown, omit: ReadonlySet<string>, measured: MeasuredLayer): Slot | undefined {
	const tokens: unknown[] = [];
	try {
		return record(value, omit, tokens) ? { kind, tokens, chars: measured.chars, hash: measured.hash } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether `layer` is what `{ kind, ...extra, chars, hash }` builds: the same keys in the same order with the same values,
 * so the same JSON.
 */
function isLayer(layer: object, kind: string, extra: object, measured: MeasuredLayer): boolean {
	const fields = layer as Record<string, unknown>;
	const keys = Object.keys(fields);
	const extraKeys = Object.keys(extra);
	const last = keys.length - 1;
	if (last !== extraKeys.length + 2 || keys[0] !== "kind" || fields.kind !== kind) return false;
	for (let i = 0; i < extraKeys.length; i++) {
		const key = extraKeys[i];
		if (keys[i + 1] !== key || fields[key] !== (extra as Record<string, unknown>)[key]) return false;
	}
	return (
		keys[last - 1] === "chars" &&
		keys[last] === "hash" &&
		fields.chars === measured.chars &&
		fields.hash === measured.hash
	);
}

/** Same own keys in the same order with the same values. */
function sameFields(left: object, right: object): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	for (let i = 0; i < leftKeys.length; i++) {
		const key = leftKeys[i];
		if (key !== rightKeys[i]) return false;
		if ((left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key]) return false;
	}
	return true;
}

/**
 * The layers of the requests one caller describes, by position in the trace. Pass the same memo to
 * `describePayloadLayers` for consecutive requests of one conversation; the result is the same as without it.
 */
export class PayloadLayerMemo {
	#api: string | undefined;
	#slots: (Slot | undefined)[] = [];
	#layers: readonly object[] = [];
	#next = 0;

	/** Starts describing one request of `api`: a memo of another API forgets what it held. */
	begin(api: string): void {
		if (api !== this.#api) {
			this.#api = api;
			this.#slots = [];
			this.#layers = [];
		}
		this.#next = 0;
	}

	/**
	 * The next layer, `build(measured)` or the previous request's object at this position when that is what `build` would
	 * return. A layer is measured with `measure` unless `value` writes the same JSON (without the keys in `omit`) as the
	 * previous request's layer of the same kind at this position did; then that layer's measure is reused.
	 */
	layer<T extends object>(
		kind: string,
		value: unknown,
		extra: object,
		omit: ReadonlySet<string>,
		measure: (value: unknown) => MeasuredLayer,
		build: (measured: MeasuredLayer) => T,
	): T {
		const position = this.#next++;
		const slot = this.#slots[position];
		let measured: MeasuredLayer;
		if (slot && slot.kind === kind && sameJson(value, omit, slot.tokens)) measured = slot;
		else {
			// Measured first: a value `JSON.stringify` rejects (a cycle, a BigInt) throws here as it does without a memo.
			measured = measure(value);
			this.#slots[position] = snapshot(kind, value, omit, measured);
		}
		const previous = this.#layers[position];
		return previous && isLayer(previous, kind, extra, measured) ? (previous as T) : build(measured);
	}

	/**
	 * Ends the request whose layers are `layers`, in wire order. A layer a describer replaced after building it, equal in
	 * every field to the previous request's layer at its position, becomes that object. `layers` is remembered as it is
	 * for the next request to reuse.
	 */
	finish(layers: object[]): void {
		const previous = this.#layers;
		for (let i = 0; i < layers.length && i < previous.length; i++) {
			if (layers[i] !== previous[i] && sameFields(layers[i], previous[i])) layers[i] = previous[i];
		}
		this.#layers = layers;
		this.#slots.length = this.#next;
	}
}
