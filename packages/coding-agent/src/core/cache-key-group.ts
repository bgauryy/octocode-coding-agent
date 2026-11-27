import {
	type Api,
	type Context,
	getInitialSystemMessage,
	getSystemMessageText,
	type Model,
	normalizeContext,
	resolveModelCapabilities,
} from "@octocodeai/octocode-ai";
import { splitSystemMessageIntoBlocks } from "@octocodeai/octocode-ai/utils/instruction-split";
import { profileCacheFacts } from "@octocodeai/octocode-ai/utils/provider-profile";
import { PROMPT_CACHE_KEY_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { findInstructionCacheBoundary } from "./model-runtime/instruction-boundary.ts";
import { forkPromptCacheKey } from "./session-manager/cache-key.ts";
import type { SessionHeader } from "./session-manager/types.ts";

/**
 * `prompt_cache_key` by prefix group, not by session. OpenAI's guide
 * (https://developers.openai.com/api/docs/guides/prompt-caching, read 2026-11-19):
 *
 * - "use a stable `prompt_cache_key` for requests that share a reusable prefix" and "Keep related requests on the same
 *   `prompt_cache_key` so they can reuse its cache": a key per session sends a new session's first request away from
 *   the machines that hold the instructions an earlier session wrote (before GPT-5.6, where the key routes);
 * - from GPT-5.6 on "OpenAI handles cache routing automatically" and "separate keys help prevent cache-hit probing
 *   across users": separate keys separate reuse, so a key per session keeps sessions from reading each other's prefix;
 * - "aim for about 15 requests per minute in total across all prefixes using each key. Partition higher-volume traffic
 *   across multiple keys using a stable, deterministic mapping": where the key routes, members are spread over shards.
 *
 * A group is what fixes the cached prefix: provider, model, a hash of the base instruction block and the declared
 * tools. The workspace is no part of it: workspaces on one machine with the same prefix share the key. Sessions of
 * one group, and their forks, share its key.
 */

/**
 * Working agents one routing key carries: 15 requests a minute over the 6 to 9 a working agent sends (measured
 * 2026-11-19 over 42k requests on this machine: median spacing 9.7 s in main sessions, 7.0 s in children).
 */
const AGENTS_PER_KEY = 2;
/** A member that sent nothing for this long no longer counts toward its shard's load; it keeps its shard. */
const ACTIVE_MS = 5 * 60_000;
/** A member gone this long is forgotten. */
const FORGET_MS = 24 * 3_600_000;

/** Where `prompt_cache_key` means OpenAI's documented cache group: OpenAI's own API. */
export function groupsByPrefix(model: Pick<Model<Api>, "api" | "baseUrl" | "provider" | "profile">): boolean {
	return (
		(model.api === "openai-responses" || model.api === "openai-completions") &&
		profileCacheFacts(model).groupsByPrefix === true
	);
}

/** OpenAI's limit on `prompt_cache_key`. */
const MAX_KEY_LENGTH = 64;

/** `key` on its shard: unchanged for shard 0, else with `-<shard>` after it, cut so the whole stays within 64 characters. */
export function shardedKey(key: string, shard: number): string {
	if (shard === 0) return key;
	const suffix = `-${shard}`;
	return `${key.slice(0, MAX_KEY_LENGTH - suffix.length)}${suffix}`;
}

/** Opaque key for a group's parts (no path, tool or task text), at most 64 characters, with its shard after a dash. */
export function prefixGroupKey(parts: readonly unknown[], shard = 0): string {
	return shardedKey(`octocode-${sha256(JSON.stringify(parts)).slice(0, 40)}`, shard);
}

/** Where a group's key is sharded: OpenAI's API before GPT-5.6, where the key routes; from GPT-5.6 OpenAI routes itself. */
function shardsKey(model: Model<Api>): boolean {
	return groupsByPrefix(model) && resolveModelCapabilities(model).cache.mechanism !== "explicit-breakpoint";
}

/**
 * Hash of the prefix a request shares with other sessions: the base instruction block (the leading system prompt up to
 * its first session-tier section, the whole prompt when it has no sections) and the tool declarations it starts with.
 */
export function instructionPrefixHash(messages: readonly { role: string }[]): string {
	const initial = getInitialSystemMessage(messages);
	if (!initial) return sha256("");
	const blocks = splitSystemMessageIntoBlocks(initial, findInstructionCacheBoundary(messages));
	const base = blocks?.cached[0] ?? getSystemMessageText(initial);
	const tools = (initial.toolsAdded ?? []).map(({ name, description, parameters }) => [name, description, parameters]);
	return sha256(JSON.stringify([base, tools]));
}

interface Member {
	shard: number;
	seenAt: number;
	/** Holds not yet released: the member counts as active while any is open, whenever it last sent. */
	holds: number;
	/** Its last hold was released: it sends nothing more and loads no shard, but keeps its shard until forgotten. */
	ended: boolean;
}

/**
 * Shards of each group's key in this process: a member (a session, a fork chain, a child run) keeps the shard it was
 * given, and a new member takes the lowest shard with fewer than `AGENTS_PER_KEY` active members. A session is active
 * while it sends (`assign` on each request); a child process sends where this process cannot see, so it is held for
 * its run (`hold`) and counts until released.
 */
export class PromptCacheKeyShards {
	private readonly groups = new Map<string, Map<string, Member>>();

	assign(group: string, member: string, now = Date.now()): number {
		return this.enter(group, member, now).shard;
	}

	/** Assigns `member` and counts it active until `release` (idempotent); it keeps its shard for a later run. */
	hold(group: string, member: string, now = Date.now()): { shard: number; release: (at?: number) => void } {
		const entry = this.enter(group, member, now);
		entry.holds++;
		let open = true;
		const release = (at = Date.now()) => {
			if (!open) return;
			open = false;
			entry.holds--;
			entry.seenAt = at;
			if (entry.holds === 0) entry.ended = true;
		};
		return { shard: entry.shard, release };
	}

	private enter(group: string, member: string, now: number): Member {
		let members = this.groups.get(group);
		if (!members) this.groups.set(group, (members = new Map()));
		const known = members.get(member);
		if (known) {
			known.seenAt = now;
			known.ended = false;
			return known;
		}
		const load = new Map<number, number>();
		for (const [id, entry] of members) {
			if (entry.holds > 0 || (!entry.ended && now - entry.seenAt <= ACTIVE_MS))
				load.set(entry.shard, (load.get(entry.shard) ?? 0) + 1);
			else if (now - entry.seenAt > FORGET_MS) members.delete(id);
		}
		let shard = 0;
		while ((load.get(shard) ?? 0) >= AGENTS_PER_KEY) shard++;
		const entry: Member = { shard, seenAt: now, holds: 0, ended: false };
		members.set(member, entry);
		return entry;
	}
}

/** The process's shards, shared by every session it hosts and the children it launches. */
const promptCacheKeyShards = new PromptCacheKeyShards();

/**
 * The key a child process receives for its run, and the release its run's end calls. Children of one prefix share
 * `key` (`childPromptCacheKey`) across parents, but each is its own process: where the key routes, the parent spreads
 * its children over shards here, one member per conversation (`member`: a resumed run keeps its shard), held until the
 * run ends. Elsewhere `key` is returned as it is and `release` does nothing.
 */
export function childRunPromptCacheKey(
	key: string,
	model: Model<Api> | undefined,
	member: string,
	shards: PromptCacheKeyShards = promptCacheKeyShards,
): { key: string; shard: number; release: () => void } {
	if (!model || !shardsKey(model)) return { key, shard: 0, release: () => undefined };
	const { shard, release } = shards.hold(key, member);
	return { key: shardedKey(key, shard), shard, release: () => release() };
}

interface SessionKeySource {
	getSessionId(): string;
	getHeader(): SessionHeader | null;
}

/**
 * The key a session's request sends when the caller set none: the prefix group's on OpenAI's API (sharded where the key
 * routes, so before GPT-5.6; `forkKey ?? session id` is the member that keeps its shard), else the fork chain's root id
 * (`forkPromptCacheKey`), else none (the session id). An explicit `OCTOCODE_PROMPT_CACHE_KEY` wins: a subagent's, which
 * its parent already sharded (`childRunPromptCacheKey`), or the user's. The group follows the request's leading system
 * message, which a session keeps until a compaction or a loadout rebuild rewrites the prefix anyway; later tool changes
 * are patches after it. A request that shares the session's cache (its compaction summary) passes its own messages and
 * gets the same key.
 */
export function promptCacheKeyFor(
	session: SessionKeySource,
	model: Model<Api>,
	messages: readonly { role: string }[],
	forkKey: string | undefined = forkPromptCacheKey(session.getHeader()),
): string | undefined {
	if (process.env[PROMPT_CACHE_KEY_ENV] || !groupsByPrefix(model)) return forkKey;
	const group = prefixGroupKey([model.provider, model.id, instructionPrefixHash(messages)]);
	if (!shardsKey(model)) return group;
	return shardedKey(group, promptCacheKeyShards.assign(group, forkKey ?? session.getSessionId()));
}

/** `promptCacheKeyFor` for the session's own requests, with the fork chain walked once per session id. */
export function sessionPromptCacheKey(session: SessionKeySource) {
	let fork: { sessionId: string; key: string | undefined } | undefined;
	return (model: Model<Api>, requestSessionId: string | undefined, context: Context | undefined) => {
		const sessionId = session.getSessionId();
		if (requestSessionId === undefined || requestSessionId !== sessionId) return undefined;
		// Walking the fork chain reads parent headers from disk.
		if (fork?.sessionId !== sessionId) fork = { sessionId, key: forkPromptCacheKey(session.getHeader()) };
		if (!context) return fork.key;
		return promptCacheKeyFor(session, model, normalizeContext(context).messages, fork.key);
	};
}
