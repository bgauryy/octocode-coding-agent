/** Isolated copy of the transcript handed to `context` handlers. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";

/**
 * Copy plain objects and arrays recursively, as `structuredClone` would, but share strings.
 * Strings are immutable, so a handler cannot observe the sharing, and the base64 of an image
 * (up to hundreds of thousands of characters) is not copied on every request. Anything that
 * is not a plain object or array (Date, typed arrays, Map, Error, ...) is cloned by
 * `structuredClone`, which also keeps its own behavior for values it rejects.
 */
function cloneValue(value: unknown, seen: Map<object, unknown>): unknown {
	if (typeof value !== "object" || value === null) return value;
	const known = seen.get(value);
	if (known !== undefined) return known;
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(cloneValue(item, seen));
		return copy;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		const copy = structuredClone(value);
		seen.set(value, copy);
		return copy;
	}
	const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
	seen.set(value, copy);
	for (const key of Object.keys(value)) copy[key] = cloneValue((value as Record<string, unknown>)[key], seen);
	return copy;
}

export function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
	return cloneValue(messages, new Map()) as AgentMessage[];
}
