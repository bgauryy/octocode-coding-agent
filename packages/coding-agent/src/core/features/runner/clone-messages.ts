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

/** The record a message keeps beside what providers receive, shared by the copy: an assistant's request trace, a tool result's structured data. */
function sharedPart(message: AgentMessage): unknown {
	if (message.role === "assistant") return message.requestTrace;
	return message.role === "toolResult" ? message.structuredContent : undefined;
}

/**
 * An assistant message's `requestTrace` and a tool result's `structuredContent` are shared, not copied: providers never
 * receive them, no `context` handler reads them, and neither changes after its message ends. Copying every trace (one
 * layer per message of its request) on every request cost more than the rest of the transcript, and copying a bash
 * result's structured data would read its output (up to 1 MiB) back from its saved file (`releaseSavedOutput`).
 */
export function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
	const seen = new Map<object, unknown>();
	for (const message of messages) {
		const shared = sharedPart(message);
		if (typeof shared === "object" && shared !== null) seen.set(shared, shared);
	}
	return cloneValue(messages, seen) as AgentMessage[];
}
