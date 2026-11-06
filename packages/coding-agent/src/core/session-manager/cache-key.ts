import { PROMPT_CACHE_KEY_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { readSessionHeaderForDiscovery } from "./storage.ts";
import type { SessionHeader } from "./types.ts";

const MAX_FORK_DEPTH = 64;

/**
 * Id of the session a fork chain started from, or undefined when the session has no recorded parent.
 *
 * A fork gets a new session id, but its history is a prefix copy of the parent's. Providers that route by
 * prompt_cache_key (OpenAI before GPT-5.6) would send the fork's first request to a different cache shard, so the fork
 * uses the chain's root id as its key. A parent file that cannot be read ends the walk at the last id known.
 */
function forkChainRootId(header: SessionHeader | null): string | undefined {
	let current = header;
	let root: string | undefined;
	const seen = new Set<string>();
	for (let depth = 0; current && depth < MAX_FORK_DEPTH && !seen.has(current.id); depth++) {
		seen.add(current.id);
		if (!current.parentSession) {
			if (current.parentSessionId) root = current.parentSessionId;
			break;
		}
		const parent = readSessionHeaderForDiscovery(current.parentSession);
		if (!parent) {
			root = current.parentSessionId ?? root;
			break;
		}
		root = parent.id;
		current = parent;
	}
	return root;
}

/** The key a session's own requests send, unless an explicit key or a subagent's shared key already routes them. */
export function forkPromptCacheKey(header: SessionHeader | null): string | undefined {
	if (process.env[PROMPT_CACHE_KEY_ENV]) return undefined;
	return forkChainRootId(header);
}
