import { describe, expect, it } from "vitest";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamOpenAI } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const base = {
	id: "gpt-test",
	name: "gpt-test",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const openai: Model<"openai-responses"> = {
	...base,
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
};
const azure: Model<"azure-openai-responses"> = {
	...base,
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example-resource.openai.azure.com/openai/v1",
};
const rejectRequest: typeof fetch = async () => Response.json({ error: { message: "intercepted" } }, { status: 400 });

async function sentMaxOutputTokens(maxTokens: number, adapter: "openai" | "azure"): Promise<unknown> {
	let payload: Record<string, unknown> | undefined;
	const options = {
		apiKey: "sk-test",
		maxRetries: 0,
		maxTokens,
		fetch: rejectRequest,
		onPayload: (value: unknown) => {
			payload = value as Record<string, unknown>;
		},
	};
	if (adapter === "openai") await streamOpenAI(openai, context, options).result();
	else await streamAzure(azure, context, options).result();
	return payload?.max_output_tokens;
}

describe("OpenAI Responses max_output_tokens floor", () => {
	it.each(["openai", "azure"] as const)("%s raises a cap below 16 to 16 and keeps larger caps", async (adapter) => {
		expect(await sentMaxOutputTokens(1, adapter)).toBe(16);
		expect(await sentMaxOutputTokens(500, adapter)).toBe(500);
	});
});
