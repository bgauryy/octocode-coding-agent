import { describe, expect, it } from "vitest";
import { getCompat as getCompletionsCompat } from "../src/api/openai-completions/compat.ts";
import { captureCompletionsMessages } from "./capture-completions-payload.ts";
import { captureResponsesPayload } from "./capture-responses-payload.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared/messages.ts";
import { normalizeContext } from "../src/compat.ts";
import type { Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "../src/types.ts";

const context = normalizeContext({
	systemPrompt: "Follow instructions.",
	messages: [{ role: "user", content: "Hi", timestamp: 0 }],
});

function completionsModel(
	provider: string,
	baseUrl: string,
	overrides: { id?: string; reasoning?: boolean; compat?: OpenAICompletionsCompat } = {},
): Model<"openai-completions"> {
	return {
		id: overrides.id ?? "reasoner-1",
		name: "Reasoner",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: overrides.reasoning ?? true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...(overrides.compat ? { compat: overrides.compat } : {}),
	};
}

async function leadingCompletionsRole(model: Model<"openai-completions">): Promise<string | undefined> {
	return (await captureCompletionsMessages(model, context, getCompletionsCompat(model)))[0]?.role;
}

describe("developer role on OpenAI-compatible completions hosts", () => {
	it("sends instructions under the system role to an unlisted host", async () => {
		for (const [provider, baseUrl] of [
			["my-proxy", "https://llm.example.com/v1"],
			["ollama", "http://localhost:11434/v1"],
			// A known host named only in the path or inside a longer label is still an unlisted host.
			["my-proxy", "https://proxy.example.com/api.openai.com/v1"],
			["my-proxy", "https://notapi.groq.com.example.com/v1"],
		] as const) {
			const model = completionsModel(provider, baseUrl);
			expect(getCompletionsCompat(model).supportsDeveloperRole, baseUrl).toBe(false);
			expect(await leadingCompletionsRole(model), baseUrl).toBe("system");
		}
	});

	it("keeps the developer role on the hosts that are known to accept it", async () => {
		for (const [provider, baseUrl, id] of [
			["openai", "https://api.openai.com/v1", "gpt-5.5"],
			["custom", "https://api.openai.com/v1", "gpt-5.5"],
			["groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b"],
			["custom", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b"],
			["xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-pro"],
			["xiaomi-token-plan-sgp", "https://token-plan-sgp.xiaomimimo.com/v1", "mimo-v2.6-pro"],
			["openrouter", "https://openrouter.ai/api/v1", "openai/gpt-5.2-codex"],
			["openrouter", "https://openrouter.ai/api/v1", "anthropic/claude-opus-4.8"],
		] as const) {
			const model = completionsModel(provider, baseUrl, { id });
			expect(getCompletionsCompat(model).supportsDeveloperRole, `${provider} ${baseUrl}`).toBe(true);
			expect(await leadingCompletionsRole(model), `${provider} ${baseUrl}`).toBe("developer");
		}
	});

	it("keeps the system role on hosts that were already excluded", () => {
		for (const [provider, baseUrl, id] of [
			["openrouter", "https://openrouter.ai/api/v1", "moonshotai/kimi-k2.6"],
			["deepseek", "https://api.deepseek.com/v1", "deepseek-reasoner"],
			["xai", "https://api.x.ai/v1", "grok-5"],
		] as const) {
			expect(getCompletionsCompat(completionsModel(provider, baseUrl, { id })).supportsDeveloperRole).toBe(false);
		}
	});

	it("lets a model's compat flag decide on any host", async () => {
		const optedIn = completionsModel("my-proxy", "https://llm.example.com/v1", {
			compat: { supportsDeveloperRole: true },
		});
		expect(await leadingCompletionsRole(optedIn)).toBe("developer");

		const optedOut = completionsModel("openai", "https://api.openai.com/v1", {
			compat: { supportsDeveloperRole: false },
		});
		expect(await leadingCompletionsRole(optedOut)).toBe("system");
	});

	it("uses the system role for a model without reasoning whatever the host", async () => {
		expect(
			await leadingCompletionsRole(completionsModel("openai", "https://api.openai.com/v1", { reasoning: false })),
		).toBe("system");
	});
});

function responsesModel(compat?: OpenAIResponsesCompat, reasoning = true): Model<"openai-responses"> {
	return {
		id: "reasoner-1",
		name: "Reasoner",
		api: "openai-responses",
		provider: "my-proxy",
		baseUrl: "https://llm.example.com/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...(compat ? { compat } : {}),
	};
}

function leadingResponsesRole(input: readonly unknown[]): unknown {
	return (input[0] as { role?: unknown }).role;
}

describe("developer role in the Responses converter", () => {
	it("takes the role from the resolved option, not from model.compat", () => {
		const optedOutInCompat = responsesModel({ supportsDeveloperRole: false });
		const providers = new Set(["openai"]);

		expect(
			leadingResponsesRole(
				convertResponsesMessages(optedOutInCompat, context, providers, { supportsDeveloperRole: true }),
			),
		).toBe("developer");
		expect(
			leadingResponsesRole(
				convertResponsesMessages(responsesModel(), context, providers, { supportsDeveloperRole: false }),
			),
		).toBe("system");
		// No resolved value: the Responses default, as the compat schema documents it.
		expect(leadingResponsesRole(convertResponsesMessages(responsesModel(), context, providers))).toBe("developer");
		expect(
			leadingResponsesRole(
				convertResponsesMessages(responsesModel(undefined, false), context, providers, { supportsDeveloperRole: true }),
			),
		).toBe("system");
	});

	it("passes the adapter's resolved compat to the converter", async () => {
		const build = async (model: Model<"openai-responses">) =>
			(await captureResponsesPayload<{ input: unknown[] }>(model, context, { apiKey: "sk-test" })).input;
		expect(leadingResponsesRole(await build(responsesModel({ supportsDeveloperRole: false })))).toBe("system");
		expect(leadingResponsesRole(await build(responsesModel({ supportsDeveloperRole: true })))).toBe("developer");
		expect(leadingResponsesRole(await build(responsesModel()))).toBe("developer");
	});
});
