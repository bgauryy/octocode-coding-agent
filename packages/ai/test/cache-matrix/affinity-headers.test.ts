/**
 * Mistral and OpenCode route by a session header. A fork continues its parent's conversation, so the header must name
 * the parent's cache key, not the fork's own session id (the prefix sits on the replica the parent used).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamMistral } from "../../src/api/mistral-conversations.ts";
import { getBuiltinModel } from "../../src/providers/all.ts";
import { fauxAssistantMessage } from "../../src/providers/faux.ts";
import { withOpenCodeSessionHeader } from "../../src/providers/opencode-headers.ts";
import type { Api, Model, ProviderStreams, StreamOptions } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { normalizeContext } from "../../src/utils/transcript.ts";

const context = () => normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

beforeEach(() => {
	for (const name of ["OCTOCODE_CACHE_RETENTION", "OCTOCODE_PROMPT_CACHE_KEY"]) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

async function mistralHeaders(options: StreamOptions): Promise<Headers> {
	let headers = new Headers();
	await streamMistral(getBuiltinModel("mistral", "mistral-large-latest"), context(), {
		maxRetries: 0,
		apiKey: "test",
		...options,
		fetch: async (_url, init) => {
			headers = new Headers(init?.headers);
			return new Response("{}", { status: 400 });
		},
	}).result();
	return headers;
}

describe("Mistral x-affinity", () => {
	it("a fork routes by the parent's key, the value its body carries", async () => {
		const headers = await mistralHeaders({ sessionId: "fork-session", promptCacheKey: "root-session" });
		expect(headers.get("x-affinity")).toBe("root-session");
	});

	it("a plain session routes by its own id", async () => {
		expect((await mistralHeaders({ sessionId: "plain" })).get("x-affinity")).toBe("plain");
	});

	it("sends no header when history caching is off", async () => {
		const headers = await mistralHeaders({ sessionId: "fork", promptCacheKey: "root", cacheRetention: "none" });
		expect(headers.has("x-affinity")).toBe(false);
	});
});

const model: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "test-api",
	provider: "opencode",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function openCodeHeaders(options: StreamOptions): StreamOptions["headers"] {
	let captured: StreamOptions | undefined;
	const done = () => {
		const events = new AssistantMessageEventStream();
		const message = fauxAssistantMessage("ok");
		events.push({ type: "done", reason: "stop", message });
		events.end(message);
		return events;
	};
	const streams: ProviderStreams = {
		stream: (_model, _context, seen) => ((captured = seen), done()),
		streamSimple: (_model, _context, seen) => ((captured = seen), done()),
	};
	withOpenCodeSessionHeader(streams).streamSimple(model, context(), options);
	return captured?.headers;
}

describe("OpenCode x-opencode-session", () => {
	it("a fork routes by the parent's key", () => {
		expect(openCodeHeaders({ sessionId: "fork-session", promptCacheKey: "root-session" })).toEqual({
			"x-opencode-session": "root-session",
		});
	});

	it("a child routes by its group key", () => {
		const env = { OCTOCODE_PROMPT_CACHE_KEY: "octocode-child-0123" };
		expect(openCodeHeaders({ sessionId: "child-session", env })).toEqual({
			"x-opencode-session": "octocode-child-0123",
		});
	});

	it("a plain session routes by its own id, with caching off too", () => {
		expect(openCodeHeaders({ sessionId: "plain", cacheRetention: "none" })).toEqual({
			"x-opencode-session": "plain",
		});
	});
});
