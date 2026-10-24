import { describe, expect, it } from "vitest";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface Payload {
	messages: { role: string; content: string | { cache_control?: { type: string; ttl?: string } }[] }[];
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

const context = normalizeContext({
	systemPrompt: "Stable instructions",
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
});

class Captured extends Error {}

function openRouterModel(id: string): Model<"openai-completions"> {
	const model = getBuiltinModel("openrouter", id as never);
	if (model.api !== "openai-completions") throw new Error(`${id} is not a chat-completions model`);
	return model;
}

async function capture(model: Model<Api>, options: StreamOptions = {}): Promise<Payload> {
	if (model.api !== "openai-completions") throw new Error(`Expected an OpenAI completions model, got ${model.api}`);
	let payload: Payload | undefined;
	await completionsStream(model as Model<"openai-completions">, context, {
		apiKey: "test-key",
		sessionId: "session-1",
		...options,
		onPayload: (value) => {
			payload = value as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

const lastControl = (payload: Payload) => {
	const content = payload.messages.at(-1)?.content;
	return Array.isArray(content) ? content.find((part) => part.cache_control)?.cache_control : undefined;
};

describe("OpenRouter models that need explicit cache breakpoints", () => {
	it.each(["qwen/qwen-plus", "qwen/qwen3-coder-flash", "deepseek/deepseek-v3.2"])(
		"marks the last message of the documented Alibaba model %s with a 5-minute breakpoint",
		async (id) => {
			const payload = await capture(openRouterModel(id));
			expect(lastControl(payload)).toEqual({ type: "ephemeral" });
		},
	);

	it("never asks Alibaba for a 1h TTL or the OpenAI 24h retention field", async () => {
		const payload = await capture(openRouterModel("qwen/qwen-plus"), { cacheRetention: "long" });
		expect(lastControl(payload)).toEqual({ type: "ephemeral" });
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("leaves snapshot endpoints the doc excludes, and automatic-cache models, without breakpoints", async () => {
		const plus = openRouterModel("qwen/qwen-plus");
		const snapshot = await capture({ ...plus, id: "qwen/qwen3.5-plus-02-15", compat: {} });
		const automatic = await capture(openRouterModel("openai/gpt-4o-mini"));
		expect(lastControl(snapshot)).toBeUndefined();
		expect(lastControl(automatic)).toBeUndefined();
	});

	it("keeps Anthropic models on OpenRouter at 1h when long retention is requested", async () => {
		const payload = await capture(openRouterModel("anthropic/claude-fable-5.1:batch"), {
			cacheRetention: "long",
		});
		expect(lastControl(payload)).toEqual({ type: "ephemeral", ttl: "1h" });
	});
});
