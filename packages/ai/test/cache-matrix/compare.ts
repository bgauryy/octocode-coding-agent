/** Comparisons the cache matrix shares: what must stay byte-identical between two requests of one conversation. */
import { expect } from "vitest";
import { bytes, extendsItems, type Wire, type WireCase } from "./wire.ts";

const MARKER_KEYS = new Set(["cache_control", "prompt_cache_breakpoint", "cachePoint"]);
/** The value without cache markers: they sit on the tail of each request, so they legitimately move. */
export const unmarked = (value: unknown): unknown =>
	JSON.parse(
		JSON.stringify(value, (key, item) => {
			if (MARKER_KEYS.has(key)) return undefined;
			// A block that carries the marker is an array of text blocks; once it is not the tail it is a plain string.
			// The two render the same prompt, so compare them in one form.
			if (key === "content" && typeof item === "string") return [{ type: "text", text: item }];
			return item;
		}) ?? "null",
	);
export const markerCount = (wire: Wire) =>
	(wire.body.match(/"(cache_control|prompt_cache_breakpoint|cachePoint)"/g) ?? []).length;

export type Part = "tools" | "instructions" | "history";

export const PARTS: Record<Part, (entry: WireCase, wire: Wire) => unknown> = {
	tools: (entry, wire) => unmarked(entry.tools(wire.payload)),
	instructions: (entry, wire) => unmarked(entry.instructions(wire.payload)),
	history: (entry, wire) => unmarked(entry.history(wire.payload)),
};
export const items = (entry: WireCase, wire: Wire) => PARTS.history(entry, wire) as unknown[];

/**
 * The parts among `parts` whose bytes differ between two requests. Tools may grow at the end (Responses appends an
 * `additional_tools` item): what the earlier request declared must stay as it was.
 */
export const changed = (entry: WireCase, a: Wire, b: Wire, parts: Part[]) =>
	parts.filter((part) => {
		const [before, after] = [PARTS[part](entry, a), PARTS[part](entry, b)];
		if (part === "tools" && Array.isArray(before) && Array.isArray(after))
			return after.length < before.length || bytes(after.slice(0, before.length)) !== bytes(before);
		return bytes(before) !== bytes(after);
	});

/** Asserts `after` opens with `before`: tools and instructions identical, the earlier conversation a byte prefix. */
export function expectAppend(entry: WireCase, before: Wire, after: Wire, skip: Part[] = []) {
	const stable = (["tools", "instructions"] as Part[]).filter((part) => !skip.includes(part));
	expect(changed(entry, before, after, stable), "parts that changed").toEqual([]);
	if (!skip.includes("history")) expect(extendsItems(items(entry, before), items(entry, after))).toBe(true);
}
