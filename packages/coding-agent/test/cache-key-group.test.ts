import { type Api, type Context, type Model, normalizeContext } from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	childRunPromptCacheKey,
	groupsByPrefix,
	instructionPrefixHash,
	PromptCacheKeyShards,
	prefixGroupKey,
	promptCacheKeyFor,
	sessionPromptCacheKey,
	shardedKey,
} from "../src/core/cache-key-group.ts";
import type { SessionHeader } from "../src/core/session-manager/types.ts";

afterEach(() => vi.unstubAllEnvs());

const MIN = 60_000;

function context(base: string, session = "project context", tools = ["read"]): Context {
	return {
		messages: [
			{
				role: "system",
				content: base,
				sections: { tools: "tool policy", project_context: session, cwd: "/work" },
				toolsAdded: tools.map((name) => ({ name, description: `${name} a file`, parameters: { type: "object" } })),
				timestamp: 0,
			},
			{ role: "user", content: "task", timestamp: 1 },
		],
	} as unknown as Context;
}

function session(id: string, header: Partial<SessionHeader> = {}) {
	const state = { id };
	return {
		state,
		source: {
			getSessionId: () => state.id,
			getHeader: () => ({ type: "session", id: state.id, timestamp: "", cwd: "/work", ...header }) as SessionHeader,
		},
	};
}

describe("prompt cache key by prefix group", () => {
	const explicit = getBuiltinModel("openai", "gpt-6.1-sol") as Model<Api>;
	const routed = getBuiltinModel("openai", "gpt-5.5") as Model<Api>;
	const anthropic = getBuiltinModel("anthropic", "claude-opus-5-5") as Model<Api>;

	it("groups only on OpenAI's own API, where the key is OpenAI's documented cache group", () => {
		expect(groupsByPrefix(explicit)).toBe(true);
		expect(groupsByPrefix(routed)).toBe(true);
		expect(groupsByPrefix(anthropic)).toBe(false);
		expect(groupsByPrefix({ ...explicit, baseUrl: "https://proxy.example/v1" })).toBe(false);
	});

	it("keys a group opaquely within OpenAI's 64-character limit", () => {
		const key = prefixGroupKey(["openai", "gpt-6.1-sol", "hash", "/home/me/secret-project"], 3);
		expect(key).toMatch(/^octocode-[0-9a-f]{40}-3$/);
		expect(key.length).toBeLessThanOrEqual(64);
		expect(key).not.toContain("secret");
		expect(prefixGroupKey(["a"])).toBe(prefixGroupKey(["a"]));
		expect(prefixGroupKey(["a"])).not.toBe(prefixGroupKey(["b"]));
	});

	it("hashes the base instruction block and tools, not the session-tier or volatile sections", () => {
		const base = instructionPrefixHash(normalizeContext(context("You are Octocode.")).messages);
		expect(instructionPrefixHash(normalizeContext(context("You are Octocode.", "other project")).messages)).toBe(base);
		expect(instructionPrefixHash(normalizeContext(context("You are someone else.")).messages)).not.toBe(base);
		expect(
			instructionPrefixHash(normalizeContext(context("You are Octocode.", "x", ["read", "edit"])).messages),
		).not.toBe(base);
	});

	it("gives two sessions of one prefix group the same key, so the second reads what the first wrote", () => {
		vi.stubEnv("OCTOCODE_PROMPT_CACHE_KEY", undefined);
		const one = session("session-one");
		const two = session("session-two");
		const keyOne = sessionPromptCacheKey(one.source)(explicit, "session-one", context("You are Octocode."));
		const keyTwo = sessionPromptCacheKey(two.source)(explicit, "session-two", context("You are Octocode."));
		expect(keyOne).toMatch(/^octocode-/);
		expect(keyTwo).toBe(keyOne);
		// The workspace is no part of the key; another base prefix is another group.
		expect(sessionPromptCacheKey(two.source)(explicit, "session-two", context("You are other."))).not.toBe(keyOne);
	});

	it("keeps a session's key while its leading prompt stays, whatever tools later patches add", () => {
		vi.stubEnv("OCTOCODE_PROMPT_CACHE_KEY", undefined);
		const one = session("stable");
		const key = sessionPromptCacheKey(one.source);
		const first = key(explicit, "stable", context("You are Octocode."));
		const patched = context("You are Octocode.");
		patched.messages.push({
			role: "system",
			content: "",
			toolsAdded: [{ name: "mcp_tool", description: "late", parameters: { type: "object" } }],
			timestamp: 2,
		} as never);
		expect(key(explicit, "stable", patched)).toBe(first);
		// A request that shares the session's cache (its summary) gets the same key from its own messages.
		expect(promptCacheKeyFor(one.source, explicit, normalizeContext(patched).messages)).toBe(first);
		one.state.id = "next";
		expect(key(explicit, "stable", context("You are Octocode."))).toBeUndefined();
	});

	it("leaves other providers, an explicit key and other sessions' requests alone", () => {
		const one = session("own", { parentSession: undefined });
		const key = sessionPromptCacheKey(one.source);
		expect(key(anthropic, "own", context("You are Octocode."))).toBeUndefined();
		expect(key(explicit, "someone-else", context("You are Octocode."))).toBeUndefined();
		vi.stubEnv("OCTOCODE_PROMPT_CACHE_KEY", "subagent-group");
		expect(sessionPromptCacheKey(one.source)(explicit, "own", context("You are Octocode."))).toBeUndefined();
	});

	it("shards a routing key by its working members, two per key (about 15 requests a minute)", () => {
		const shards = new PromptCacheKeyShards();
		expect(shards.assign("g", "a", 0)).toBe(0);
		expect(shards.assign("g", "b", 0)).toBe(0);
		expect(shards.assign("g", "c", 0)).toBe(1);
		// Members keep their shard: the mapping is stable.
		expect(shards.assign("g", "a", MIN)).toBe(0);
		// A member idle for over five minutes no longer loads its shard, but keeps it when it returns.
		expect(shards.assign("g", "d", 10 * MIN)).toBe(0);
		expect(shards.assign("g", "b", 11 * MIN)).toBe(0);
		expect(shards.assign("other", "c", 0)).toBe(0);
	});

	it("holds a child run's shard for the whole run, and frees its load when the run ends", () => {
		const shards = new PromptCacheKeyShards();
		const a = shards.hold("g", "a", 0);
		const b = shards.hold("g", "b", 0);
		expect([a.shard, b.shard]).toEqual([0, 0]);
		// Held members count however long ago they were assigned: a child sends where the parent cannot see.
		expect(shards.hold("g", "c", 60 * MIN).shard).toBe(1);
		a.release(61 * MIN);
		a.release(61 * MIN); // idempotent
		expect(shards.assign("g", "d", 61 * MIN)).toBe(0);
		// A resumed conversation keeps its shard (its history is cached there), even on a full shard.
		expect(shards.hold("g", "a", 62 * MIN).shard).toBe(0);
		expect(shards.assign("g", "e", 62 * MIN)).toBe(1);
		expect(shards.assign("g", "f", 62 * MIN)).toBe(2);
	});

	it("shards a child's key on OpenAI before GPT-5.6 only, within the 64-character limit", () => {
		const shards = new PromptCacheKeyShards();
		const key = `octocode-child-${"a".repeat(48)}`;
		const runs = ["one", "two", "three"].map((member) => childRunPromptCacheKey(key, routed, member, shards));
		expect(runs.map((run) => run.shard)).toEqual([0, 0, 1]);
		expect(runs[0].key).toBe(key);
		expect(runs[1].key).toBe(key);
		expect(runs[2].key).not.toBe(key);
		expect(runs[2].key.length).toBeLessThanOrEqual(64);
		expect(runs[2].key).toMatch(/-1$/);
		// Ended runs free their shard for the next child.
		runs[0].release();
		runs[1].release();
		expect(childRunPromptCacheKey(key, routed, "four", shards).shard).toBe(0);
		for (const model of [explicit, anthropic, undefined])
			expect(childRunPromptCacheKey(key, model, "five", shards)).toMatchObject({ key, shard: 0 });
		expect(shardedKey("x".repeat(64), 12)).toHaveLength(64);
		expect(shardedKey("short", 0)).toBe("short");
	});

	it("shards sessions where the key routes (before GPT-5.6), never where OpenAI routes by itself", () => {
		vi.stubEnv("OCTOCODE_PROMPT_CACHE_KEY", undefined);
		const keys = (model: Model<Api>) =>
			["r1", "r2", "r3"].map((id) =>
				sessionPromptCacheKey(session(id).source)(model, id, context("You are Octocode.")),
			);
		const [a, b, c] = keys(routed);
		expect(b).toBe(a);
		expect(c).toBe(`${a}-1`);
		expect(new Set(keys(explicit)).size).toBe(1);
	});
});
