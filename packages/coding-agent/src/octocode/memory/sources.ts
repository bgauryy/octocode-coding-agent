import { formatAnchor, parseAnchor } from "@octocodeai/octocode-contracts/evidence";
import { memorySources } from "../../../../db/src/api.ts";
import { MemoryError } from "./errors.ts";

/** The source anchors a note links to (`memory_sources`): validated on the way in, and again on the way out. */
export const { MAX_MEMORY_SOURCES } = memorySources;

/**
 * The canonical text forms of `anchors`, duplicates removed. Refuses a malformed anchor or more than
 * `MAX_MEMORY_SOURCES`, so a save never links to something that cannot be opened.
 */
export function canonicalSources(anchors: readonly string[]): string[] {
	const out = new Set<string>();
	for (const text of anchors) {
		const anchor = parseAnchor(text);
		if (!anchor)
			throw new MemoryError(
				`sources: "${text.slice(0, 80)}" is not a source anchor (archive:<session>/<segment>/<entry> or transcript:<session>/<entry>).`,
			);
		out.add(formatAnchor(anchor));
	}
	if (out.size > MAX_MEMORY_SOURCES)
		throw new MemoryError(`sources: at most ${MAX_MEMORY_SOURCES} anchors per note (got ${out.size}).`);
	return [...out];
}

/** The stored anchors that still parse; a row no longer valid is left out rather than shown as a link. */
export const readableSources = (stored: readonly string[]): string[] =>
	stored.filter((text) => parseAnchor(text) !== undefined);

/** The `sources:` line of a note's full view; "" when it has none. */
export const sourcesLine = (anchors: readonly string[]): string =>
	anchors.length > 0 ? `sources: ${anchors.join(", ")}` : "";
