import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProviderTextRedactor } from "../src/utils/error-body.ts";
import { stream } from "../src/api/azure-openai-responses.ts";
import { responsesPayload } from "../src/api/ai-sdk/responses-payload.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import type { Model } from "../src/types.ts";

const model: Model<"azure-openai-responses"> = {
	id: "deployment",
	name: "Deployment",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://resource.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

describe("Azure Responses SDK migration", () => {
	beforeEach(() =>
		setProviderTextRedactor((text) =>
			text.replaceAll("secret-key", "[redacted]").replaceAll("secret-token", "[redacted]"),
		),
	);
	afterEach(() => setProviderTextRedactor(undefined));
	it.each(["key", "token", "bearer"] as const)(
		"sends exactly one credential in %s mode and redacts errors",
		async (mode) => {
			const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("api-key")).toBe(mode === "key" ? "secret-key" : null);
				expect(headers.get("authorization")).toBe(mode === "key" ? null : "Bearer secret-token");
				return new Response(JSON.stringify({ error: { message: "denied secret-key secret-token" } }), { status: 401 });
			});
			const output = await stream(model, context, {
				...(mode === "bearer" ? { headers: { Authorization: "Bearer secret-token" } } : { apiKey: "secret-key" }),
				...(mode === "token" ? { azureADTokenProvider: async () => "secret-token" } : {}),
				fetch,
			}).result();
			expect(fetch).toHaveBeenCalledOnce();
			expect(output.stopReason).toBe("error");
			expect(output.errorMessage).not.toContain("secret-key");
			expect(output.errorMessage).not.toContain("secret-token");
		},
	);

	it("keeps OpenAI instruction breakpoint augmentation byte-identical", () => {
		const openai: Model<"openai-responses"> = {
			...model,
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			compat: { supportsExplicitPromptCacheMode: true },
		};
		const transcript = normalizeContext({
			messages: [
				{ role: "system", content: "stable", timestamp: 1 },
				{ role: "user", content: "hi", timestamp: 2 },
			],
		});
		const body = {
			model: "deployment",
			input: [
				{ role: "system", content: "stable" },
				{ role: "user", content: "hi" },
			],
			stream: true,
		};
		responsesPayload(openai, transcript, { instructionCacheRetention: "long" })(body);
		expect(JSON.stringify(body)).toBe(
			'{"model":"deployment","input":[{"role":"system","content":[{"type":"input_text","text":"stable","prompt_cache_breakpoint":{"mode":"explicit","ttl":"12h"}}]},{"role":"user","content":"hi"}],"stream":true}',
		);
	});
});
