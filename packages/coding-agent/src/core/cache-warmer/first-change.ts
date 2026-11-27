import type { RequestLayer, RequestTrace } from "@octocodeai/octocode-ai";

/**
 * The earliest payload layer of a request that differs from the previous request's (RFC F7), from `payload-layers`
 * hashes. `append`: the previous request is an unchanged prefix (a cache hit up to its end); `none`: identical;
 * `cold`: no previous request to compare with; `tools`, `system`, `message`: the kind of the first changed layer.
 */
export interface LayerChange {
	area: "cold" | "none" | "append" | "tools" | "system" | "message";
	/** Position of the first changed or appended layer in the wire order. */
	position?: number;
	/** For `system` and `message`: the layer's index inside its payload section. */
	index?: number;
}

const sameLayer = (a: RequestLayer, b: RequestLayer): boolean => a.kind === b.kind && a.hash === b.hash;

function changedAt(layer: RequestLayer, position: number): LayerChange {
	return {
		area: layer.kind,
		position,
		...(layer.kind !== "tools" && layer.index !== undefined ? { index: layer.index } : {}),
	};
}

/** The first change from `previous` to `current`; undefined when `current` has no trace (an API without a describer). */
export function firstChangedArea(
	previous: RequestTrace | undefined,
	current: RequestTrace | undefined,
): LayerChange | undefined {
	if (!current) return undefined;
	if (!previous) return { area: "cold" };
	const before = previous.layers;
	const after = current.layers;
	const shared = Math.min(before.length, after.length);
	for (let position = 0; position < shared; position++) {
		if (!sameLayer(before[position], after[position])) return changedAt(after[position], position);
	}
	// A shorter request dropped layers: the first dropped one is where the prefix ends.
	if (after.length < before.length) return changedAt(before[shared], shared);
	return after.length > before.length ? { area: "append", position: shared } : { area: "none" };
}

/** Short label: `append`, `tools`, `system[2]`, `message[14]`. */
export function formatLayerChange(change: LayerChange): string {
	return change.index !== undefined ? `${change.area}[${change.index}]` : change.area;
}

/** Whether `a` is a costlier change than `b`: a changed layer over an append, an earlier position over a later one. */
export function isEarlierChange(a: LayerChange, b: LayerChange): boolean {
	const rank = (change: LayerChange) =>
		change.area === "none" || change.area === "append" ? Number.POSITIVE_INFINITY : (change.position ?? -1);
	return rank(a) < rank(b);
}
