/**
 * Which file a catalog gets, for sessions (`presentation/`): the stored file while this generator rendered it from this
 * exact catalog, else a new render from the server's own text, which is stored.
 */

import { catalogHash, COMPACT_GENERATOR_VERSION, renderServer } from "./render.ts";
import { readGenerated, writeGenerated } from "./store.ts";
import type { CompactServerInput, GeneratedMeta } from "./types.ts";

export interface ServerFile {
	text: string;
	meta: GeneratedMeta;
}

/**
 * `name` is the configured server name, which names the stored files. A failed write changes nothing for the caller:
 * the stored files are a cache, so the text rendered now is returned either way.
 */
export function resolveServerFile(dir: string, name: string, input: CompactServerInput): ServerFile {
	const hash = catalogHash(input);
	const stored = readGenerated(dir, name);
	if (stored?.meta.hash === hash && stored.meta.generatorVersion === COMPACT_GENERATOR_VERSION)
		return { text: stored.text, meta: stored.meta };
	const text = renderServer(input);
	const meta: GeneratedMeta = {
		hash,
		generatorVersion: COMPACT_GENERATOR_VERSION,
		generatedAt: new Date().toISOString(),
	};
	try {
		writeGenerated(dir, name, text, meta);
	} catch {
		// An unwritable store only costs the cache: this session reads the text rendered here.
	}
	return { text, meta };
}
