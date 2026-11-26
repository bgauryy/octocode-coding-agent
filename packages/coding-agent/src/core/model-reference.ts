/**
 * The one grammar of a model reference, shared by every setting and flag that names a model:
 *
 *     [provider/]id[:level]
 *
 * - `provider/` is optional; the provider ends at the first `/`, and the id may hold more slashes (gateway ids) and colons.
 * - `:level` is a thinking level (`off` … `max`) and counts only as the last segment; any other trailing text is part of the id.
 * - `provider` and `id` may hold the glob characters `*`, `?` and `[`; whether they match any model is the resolver's call
 *   (an id such as `bracketed-model[1m]` is not a glob).
 *
 * Resolving a reference against the catalog is `model-resolver/`'s job; this module only reads the text.
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { isValidThinkingLevel } from "./thinking-level.ts";

export interface ModelReference {
	/** The text before the first `/`; a hint, since a gateway id may itself start with `zai/`. */
	provider?: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
	/** Whether the provider or id holds a glob character. */
	glob: boolean;
}

/** A reference the grammar rejects: empty, or a `/` with nothing on one side. */
export class ModelReferenceError extends Error {
	override readonly name = "ModelReferenceError";
}

/** The text split before a trailing `:level`, or undefined when it ends in no valid level (or starts with the colon). */
export function splitThinkingSuffix(text: string): { base: string; thinkingLevel: ThinkingLevel } | undefined {
	const colonIndex = text.lastIndexOf(":");
	if (colonIndex <= 0) return undefined;
	const suffix = text.substring(colonIndex + 1);
	return isValidThinkingLevel(suffix) ? { base: text.substring(0, colonIndex), thinkingLevel: suffix } : undefined;
}

/** Whether the text holds a glob character (`*`, `?`, `[`). */
export function hasGlob(text: string): boolean {
	return text.includes("*") || text.includes("?") || text.includes("[");
}

function parse(text: string): ModelReference | string {
	const trimmed = text.trim();
	if (!trimmed) return "a model reference is empty";
	const thinking = splitThinkingSuffix(trimmed);
	const base = thinking?.base ?? trimmed;
	const slash = base.indexOf("/");
	if (slash === 0) return `"${trimmed}" names no provider before "/"`;
	if (slash === base.length - 1) return `"${trimmed}" names no model after "/"`;
	return {
		...(slash > 0 ? { provider: base.slice(0, slash) } : {}),
		id: slash > 0 ? base.slice(slash + 1) : base,
		...(thinking ? { thinkingLevel: thinking.thinkingLevel } : {}),
		glob: hasGlob(base),
	};
}

/** Reads `[provider/]id[:level]`. Throws `ModelReferenceError` naming what is wrong. */
export function parseModelReference(text: string): ModelReference {
	const parsed = parse(text);
	if (typeof parsed === "string")
		throw new ModelReferenceError(`Invalid model reference: ${parsed}. Use provider/id[:level].`);
	return parsed;
}

/** The provider a reference names (`provider/id[:level]`), or undefined for a bare id or text the grammar rejects. */
export function referenceProvider(text: string | undefined): string | undefined {
	return text ? tryParseModelReference(text)?.provider : undefined;
}

/** Like `parseModelReference`, but undefined for a reference the grammar rejects. */
export function tryParseModelReference(text: string): ModelReference | undefined {
	const parsed = parse(text);
	return typeof parsed === "string" ? undefined : parsed;
}
