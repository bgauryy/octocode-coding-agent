import { afterEach, describe, expect, it, vi } from "vitest";
import { getModels, streamSimple } from "../src/compat.ts";
import { getOpenCodeBaseUrl, withOpenCodeEndpoint } from "../src/providers/opencode-endpoints.ts";
import type { Api, Model } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

const operations = {
	"openai-responses": "/responses",
	"openai-completions": "/chat/completions",
	"anthropic-messages": "/v1/messages",
	"google-generative-ai": "/models/",
};

describe.each(["opencode", "opencode-go"] as const)("OpenCode routing: %s", (provider) => {
	const models = getModels(provider);
	it.each(Object.keys(operations))("routes the %s transport with conversation and client identity", async (api) => {
		const model = models.find((entry) => entry.api === api);
		expect(model, `catalog missing ${api}`).toBeDefined();
		if (!model) return;
		expect(model.baseUrl).toBe(getOpenCodeBaseUrl(provider, api));
		const requests: Request[] = [];
		const capture: typeof fetch = async (input, init) => {
			requests.push(new Request(input, init));
			return Response.json({ error: { message: "intercepted" } }, { status: 400 });
		};
		vi.stubGlobal("fetch", capture);
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Inspect the code", timestamp: 0 }] },
			{
				apiKey: "test-only-key",
				sessionId: "stable-session",
				maxRetries: 0,
				fetch: api === "google-generative-ai" ? undefined : capture,
				headers: { "User-Agent": "octocode/test" },
			},
		).result();
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.url).toContain(`${model.baseUrl}${operations[api as keyof typeof operations]}`);
		expect(request.headers.get("x-opencode-session")).toBe("stable-session");
		expect(request.headers.get("user-agent")).toBe("octocode/test");
		expect(await request.json()).toHaveProperty(api === "google-generative-ai" ? "contents" : "model");
	});

	it("preserves catalog IDs and upgrades old remote roots without changing custom URLs", () => {
		for (const model of models) {
			for (const root of ["zen", "inference"]) {
				const baseUrl = `https://opencode.ai/${root}${provider === "opencode-go" ? "/go" : ""}/v1`;
				const updated = withOpenCodeEndpoint({ ...model, baseUrl });
				expect(updated).toEqual({ ...model, baseUrl: getOpenCodeBaseUrl(provider, model.api) });
			}
			const custom: Model<Api> = { ...model, baseUrl: "https://proxy.example/custom/v1" };
			expect(withOpenCodeEndpoint(custom)).toBe(custom);
		}
	});
});
