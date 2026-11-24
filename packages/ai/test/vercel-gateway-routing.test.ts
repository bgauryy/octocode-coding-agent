import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { VercelGatewayRoutingSchema } from "../src/providers/compat-schema/common.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Routing = NonNullable<Model<"anthropic-messages">["compat"]>["vercelGatewayRouting"];
type CompletionRouting = NonNullable<Model<"openai-completions">["compat"]>["vercelGatewayRouting"];

async function sentBody(routing: Routing, options: { sessionId?: string; cacheRetention?: "none" | "short" } = {}) {
	const base = getBuiltinModel("anthropic", "claude-sonnet-4-6");
	const model: Model<"anthropic-messages"> = {
		...base,
		provider: "vercel-ai-gateway",
		baseUrl: "http://127.0.0.1:9",
		compat: { ...base.compat, vercelGatewayRouting: routing },
	};
	let body: Record<string, unknown> | undefined;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		throw new Error("request captured");
	};
	await streamAnthropic(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
		apiKey: "k",
		fetch,
		maxRetries: 0,
		...options,
	}).result();
	return { body, model };
}

async function sentCompletionBody(
	routing: CompletionRouting,
	options: { sessionId?: string; cacheRetention?: "none" | "short" } = {},
) {
	const { compat: _compat, ...base } = getBuiltinModel("openai", "gpt-4o-mini");
	const model: Model<"openai-completions"> = {
		...base,
		api: "openai-completions",
		provider: "vercel-ai-gateway",
		baseUrl: "http://127.0.0.1:9/v1",
		compat: { vercelGatewayRouting: routing },
	};
	let body: Record<string, unknown> | undefined;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		throw new Error("request captured");
	};
	await streamOpenAICompletions(
		model,
		normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
		{ apiKey: "k", fetch, maxRetries: 0, ...options },
	).result();
	return { body, model };
}

describe("Vercel AI Gateway routing on the Anthropic Messages path", () => {
	it("sends the documented routing controls as providerOptions.gateway", async () => {
		const routing = {
			only: ["anthropic", "bedrock"],
			order: ["bedrock", "anthropic"],
			models: ["openai/gpt-5.1"],
			sort: "cost" as const,
			headquarters: ["US"],
			caching: "auto" as const,
			zeroDataRetention: true,
			disallowPromptTraining: true,
			providerTimeouts: { byok: { anthropic: 5000 } },
		};
		const { body } = await sentBody(routing);
		expect(body?.providerOptions).toEqual({ gateway: routing });
	});

	it("adds the session as sessionId without changing the model's routing", async () => {
		const routing = { order: ["anthropic"] };
		const { body, model } = await sentBody(routing, { sessionId: "sess-1" });
		expect((body?.providerOptions as { gateway: object } | undefined)?.gateway).toEqual({
			order: ["anthropic"],
			sessionId: "sess-1",
		});
		expect(model.compat?.vercelGatewayRouting).toEqual({ order: ["anthropic"] });
	});

	it("sends no session when affinity is off, caching is off or the routing names one", async () => {
		const off = await sentBody({ sessionAffinity: false }, { sessionId: "s" });
		expect(off.body?.providerOptions).toEqual({ gateway: { sessionAffinity: false } });
		const none = await sentBody({ order: ["anthropic"] }, { sessionId: "s", cacheRetention: "none" });
		expect(none.body?.providerOptions).toEqual({ gateway: { order: ["anthropic"] } });
		const own = await sentBody({ sessionId: "own" } as Routing, { sessionId: "s" });
		expect(own.body?.providerOptions).toEqual({ gateway: { sessionId: "own" } });
	});

	it("sends nothing for a model without routing", async () => {
		expect((await sentBody(undefined)).body?.providerOptions).toBeUndefined();
		expect((await sentBody({})).body?.providerOptions).toBeUndefined();
	});

	it("validates control shapes", () => {
		expect(Value.Check(VercelGatewayRoutingSchema, { sort: "ttft", providerTimeouts: { byok: { a: 1 } } })).toBe(true);
		expect(Value.Check(VercelGatewayRoutingSchema, { sort: "fastest" })).toBe(false);
		expect(Value.Check(VercelGatewayRoutingSchema, { providerTimeouts: { byok: { a: 0 } } })).toBe(false);
	});
});

describe("Vercel AI Gateway routing on Chat Completions", () => {
	it("copies routing and adds the session without changing the model's routing", async () => {
		const routing = { order: ["anthropic"], providerTimeouts: { byok: { anthropic: 5000 } } };
		const { body, model } = await sentCompletionBody(routing, { sessionId: "chat-session" });
		expect(body?.providerOptions).toEqual({ gateway: { ...routing, sessionId: "chat-session" } });
		expect(model.compat?.vercelGatewayRouting).toEqual(routing);
	});

	it("does not add a session when caching or affinity is off", async () => {
		const none = await sentCompletionBody({ order: ["anthropic"] }, { sessionId: "s", cacheRetention: "none" });
		expect(none.body?.providerOptions).toEqual({ gateway: { order: ["anthropic"] } });
		const off = await sentCompletionBody({ sessionAffinity: false }, { sessionId: "s" });
		expect(off.body?.providerOptions).toEqual({ gateway: { sessionAffinity: false } });
	});
});
