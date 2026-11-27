import { mcpToolName, type NamePattern, type Trace, type TraceEvent } from "../trace.ts";

export interface Result {
	pass: boolean;
	message: () => string;
}

export interface CalledOptions {
	/** Partial match: every given key must equal (deeply) the call's argument. */
	args?: Record<string, unknown>;
	/**
	 * `'answer'`: an answer by the call's own agent must follow the call. A tool name pattern (exact, `*` glob or
	 * RegExp): the call must happen before the first call of that tool. With `times`, every counted call must.
	 */
	before?: NamePattern;
	/** Exact number of matching calls; checked together with `before`. */
	times?: number;
}

export const fail = (message: string): Result => ({ pass: false, message: () => message });
/**
 * Throws instead of returning `pass: false`: under `.not` a failed result would turn into a silent pass,
 * and "no data" must never count as evidence either way.
 */
export const cannot = (what: string): never => {
	throw new Error(`cannot observe: ${what}`);
};

function asTrace(v: unknown): Trace | undefined {
	const t = v as Partial<Trace> | null;
	return t && Array.isArray(t.requests) && Array.isArray(t.events) ? (v as Trace) : undefined;
}

export function needTrace(v: unknown): Trace {
	const t = asTrace(v) ?? cannot("received value is not a Trace");
	if (!t.requests.length && !t.events.length) cannot("empty trace (no requests, no events)");
	return t;
}

/**
 * JSON with object keys sorted at every depth and nothing masked: dates, call ids and secret-shaped strings stay
 * as sent, so two values are equal only when the model sent the same thing. Argument checks compare this form.
 */
function stableJson(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v).toSorted()) out[k] = sort((v as Record<string, unknown>)[k]);
			return out;
		}
		return v;
	};
	return JSON.stringify(sort(value)) ?? "undefined";
}

/** Deep equality on the unmasked, key-order-independent form (`stableJson`). */
export const sameValue = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/** Whether every key of `want`, at every object depth, equals the same key of `actual`; arrays compare whole. */
export function subset(actual: unknown, want: unknown): boolean {
	if (want && typeof want === "object" && !Array.isArray(want)) {
		if (!actual || typeof actual !== "object") return false;
		return Object.entries(want).every(([k, v]) => subset((actual as Record<string, unknown>)[k], v));
	}
	return sameValue(actual, want);
}

export const describeArgs = (e: TraceEvent): string => `#${e.seq} ${e.name}(${JSON.stringify(e.args)})`;

/** Whether a name (raw, or namespaced by an agent) refers to the tool of a server-side event. */
export const sameTool = (name: string | undefined, ev: TraceEvent): boolean =>
	name !== undefined &&
	ev.name !== undefined &&
	(name === ev.name || (ev.server !== undefined && name === mcpToolName(ev.server, ev.name)));
