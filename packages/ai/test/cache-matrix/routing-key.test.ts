/**
 * A fork or child shares its parent's prompt cache key, so every request that routes by session must route by that key:
 * a routing header that carries the fork's own session id sends the identical prefix to another replica.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModel } from "../../src/providers/all.ts";
import type { Model, StreamOptions } from "../../src/types.ts";
import { normalizeContext } from "../../src/utils/transcript.ts";
import { wireCase, wireRequest, type WireId } from "./wire.ts";

const context = () =>
	normalizeContext({
		systemPrompt: "Stable instructions",
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	});

interface Route {
	id: WireId;
	/** Headers that name the conversation for the provider's cache router. */
	headers: string[];
	/** Body field carrying the key; undefined where the API sends none. */
	keyField?: string;
	/** History retention at which the body carries the key (completions send it from `long` on). Default: `short`. */
	keyRetention?: "short" | "long";
	model?: () => Model<any>;
}

/** A Claude model reached through an OpenRouter-style endpoint, which sends the session-affinity header. */
const anthropicWithAffinity = (): Model<any> => {
	const base = getBuiltinModel("anthropic", "claude-haiku-4-5");
	return { ...base, compat: { ...base.compat, sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" } };
};

const ROUTES: Route[] = [
	{ id: "xai", headers: ["x-grok-conv-id", "x-client-request-id"], keyField: "prompt_cache_key" },
	{ id: "codex", headers: ["session-id", "x-client-request-id"], keyField: "prompt_cache_key" },
	{ id: "completions-explicit", headers: ["x-session-id"], keyField: "prompt_cache_key", keyRetention: "long" },
	{ id: "responses", headers: ["x-client-request-id"], keyField: "prompt_cache_key" },
	{ id: "anthropic", headers: ["x-session-id"], model: anthropicWithAffinity },
];

beforeEach(() => {
	for (const name of ["OCTOCODE_CACHE_RETENTION", "OCTOCODE_INSTRUCTION_CACHE_RETENTION", "OCTOCODE_PROMPT_CACHE_KEY"])
		vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

const send = (route: Route, options: StreamOptions) =>
	wireRequest(wireCase(route.id), context(), options, route.model?.());

describe.each(ROUTES)("routing headers of $id follow the prompt cache key", (route) => {
	it("a fork (own session id, parent's key) routes by the parent's key, the same value the body carries", async () => {
		const cacheRetention = route.keyRetention ?? "short";
		const wire = await send(route, { sessionId: "fork-session", promptCacheKey: "root-session", cacheRetention });
		for (const header of route.headers) expect(wire.headers.get(header), header).toBe("root-session");
		if (route.keyField) expect(wire.payload[route.keyField]).toBe("root-session");
	});

	it("a child (key from OCTOCODE_PROMPT_CACHE_KEY) routes by that key", async () => {
		const env = { OCTOCODE_PROMPT_CACHE_KEY: "octocode-child-0123" };
		const wire = await send(route, { sessionId: "child-session", env, cacheRetention: route.keyRetention ?? "short" });
		for (const header of route.headers) expect(wire.headers.get(header), header).toBe("octocode-child-0123");
		if (route.keyField) expect(wire.payload[route.keyField]).toBe("octocode-child-0123");
	});

	it("a plain session keeps routing by its own id", async () => {
		const wire = await send(route, { sessionId: "plain-session", cacheRetention: "short" });
		for (const header of route.headers) expect(wire.headers.get(header), header).toBe("plain-session");
	});

	it("sends no routing header when history caching is off, whatever the key", async () => {
		const wire = await send(route, {
			sessionId: "fork-session",
			promptCacheKey: "root-session",
			cacheRetention: "none",
		});
		for (const header of route.headers) expect(wire.headers.has(header), header).toBe(false);
		if (route.keyField) expect(wire.payload[route.keyField]).toBeUndefined();
	});
});

describe("header shape", () => {
	it("keeps a key longer than the OpenAI limit within 64 characters in the body and the Codex headers alike", async () => {
		const key = `octocode-child-${"a".repeat(80)}`;
		const wire = await send(ROUTES[1], { sessionId: "s", promptCacheKey: key, cacheRetention: "short" });
		const sent = wire.payload.prompt_cache_key as string;
		expect(sent.length).toBeLessThanOrEqual(64);
		expect(wire.headers.get("session-id")).toBe(sent);
		expect(wire.headers.get("x-client-request-id")).toBe(sent);
	});

	it("xAI keeps the conversation id and the request id as separate, present headers", async () => {
		const wire = await send(ROUTES[0], { sessionId: "s", promptCacheKey: "k", cacheRetention: "short" });
		expect(wire.headers.has("x-grok-conv-id")).toBe(true);
		expect(wire.headers.has("x-client-request-id")).toBe(true);
	});
});
