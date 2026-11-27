import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinModels, builtinProviders } from "../src/providers/all.ts";
import {
	checkCredentialByList,
	discoverProviderModels,
	MODEL_DISCOVERY_SOURCES,
	requestVendorModels,
} from "../src/providers/discovery.ts";

const configured = () => builtinModels({ authContext: { env: async () => "key", fileExists: async () => false } });

describe("vendor model discovery", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("has an explicit discovery strategy for every built-in vendor", () => {
		expect(Object.keys(MODEL_DISCOVERY_SOURCES).sort()).toEqual(
			builtinProviders()
				.map((provider) => provider.id)
				.sort(),
		);
	});

	it("reports new and missing IDs without creating inference metadata", async () => {
		const models = configured();
		const known = models.getModels("deepseek")[0];
		const fetch = vi.fn(async (url, init) => {
			expect(String(url)).toBe("https://api.deepseek.com/models");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
			expect(init?.redirect).toBe("error");
			return Response.json({ data: [{ id: known.id }, { id: "new-vendor-model" }] });
		}) as typeof globalThis.fetch;
		const before = models.getAllModels("deepseek");
		const result = await discoverProviderModels(models, "deepseek", { fetch });
		expect(result.status).toBe("verified");
		expect(result.models).toContainEqual({ id: "new-vendor-model", known: false });
		expect(result.models[1]).not.toHaveProperty("cost");
		expect(models.getAllModels("deepseek")).toEqual(before);
	});

	it("does not perform network or resolve credentials in offline mode", async () => {
		const models = configured();
		const getAuth = vi.spyOn(models, "getAuth");
		const fetch = vi.fn();
		expect((await discoverProviderModels(models, "openai", { allowNetwork: false, fetch })).status).toBe("catalog");
		expect(fetch).not.toHaveBeenCalled();
		expect(getAuth).not.toHaveBeenCalled();
	});

	it("reports control-plane/manual strategies without probing inference /models", async () => {
		const fetch = vi.fn();
		const result = await discoverProviderModels(configured(), "amazon-bedrock", { fetch });
		expect(result.status).toBe("unsupported");
		expect(result.note).toContain("control-plane");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads public gateway catalogs without requesting a credential", async () => {
		const models = configured();
		const auth = vi.spyOn(models, "getAuth");
		const fetch = vi.fn(async () => Response.json({ data: [{ id: "public-model" }] }));
		const result = await discoverProviderModels(models, "vercel-ai-gateway", { fetch });
		expect(result.status).toBe("verified");
		expect(auth).not.toHaveBeenCalled();
	});

	it("paginates Gemini models and preserves server limits", async () => {
		const urls: string[] = [];
		const fetch = vi.fn(async (url, init) => {
			urls.push(String(url));
			expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("google-key");
			return Response.json(
				urls.length === 1
					? { models: [{ name: "models/first", displayName: "First", inputTokenLimit: 100 }], nextPageToken: "next" }
					: { models: [{ name: "models/second", outputTokenLimit: 20 }] },
			);
		}) as typeof globalThis.fetch;
		const rows = await requestVendorModels(configured().getProvider("google")!, { apiKey: "google-key" }, { fetch });
		expect(rows).toEqual([
			{ id: "first", name: "First", inputTokenLimit: 100 },
			{ id: "second", name: "models/second", outputTokenLimit: 20 },
		]);
		expect(urls[1]).toContain("pageToken=next");
	});

	it("uses Anthropic authentication and follows after_id pagination", async () => {
		const urls: string[] = [];
		const fetch = vi.fn(async (url, init) => {
			urls.push(String(url));
			expect(new Headers(init?.headers).get("x-api-key")).toBe("anthropic-key");
			return Response.json(
				urls.length === 1
					? { data: [{ id: "first" }], has_more: true, last_id: "first" }
					: { data: [{ id: "second" }], has_more: false },
			);
		}) as typeof globalThis.fetch;
		expect(
			(await requestVendorModels(configured().getProvider("anthropic")!, { apiKey: "anthropic-key" }, { fetch })).map(
				(model) => model.id,
			),
		).toEqual(["first", "second"]);
		expect(urls[1]).toContain("after_id=first");
	});

	it("rejects incomplete pagination rather than claiming a complete list", async () => {
		const fetch = vi.fn(async () => Response.json({ data: [{ id: "first" }], has_more: true }));
		await expect(
			requestVendorModels(configured().getProvider("anthropic")!, { apiKey: "key" }, { fetch }),
		).rejects.toThrow("pagination cursor");
	});

	it("honors configured endpoints without following response-provided URLs", async () => {
		const provider = configured().getProvider("deepseek")!;
		const fetch = vi.fn(async (url) => {
			expect(String(url)).toBe("https://proxy.example/custom/models");
			return Response.json({ data: [{ id: "model" }], next: "https://attacker.example/collect" });
		}) as typeof globalThis.fetch;
		await requestVendorModels(provider, {}, { fetch, baseUrl: "https://proxy.example/custom" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not expose an authentication error response body", async () => {
		const fetch = vi.fn(async () => new Response("access-token-secret", { status: 401 }));
		const result = await discoverProviderModels(configured(), "deepseek", { fetch });
		expect(result).toMatchObject({ status: "error", note: "Vendor model discovery failed (HTTP 401)" });
		expect(JSON.stringify(result)).not.toContain("access-token-secret");
	});

	it("uses ChatGPT visibility and slug semantics", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				models: [
					{ slug: "visible", display_name: "Visible", visibility: "list" },
					{ slug: "hidden", visibility: "hidden" },
				],
			}),
		);
		const rows = await requestVendorModels(
			configured().getProvider("openai")!,
			{ apiKey: "token" },
			{ fetch, chatGPT: true },
		);
		expect(rows).toEqual([{ id: "visible", name: "Visible" }]);
	});

	it("rejects a vendor list whose model ID carries a terminal control or bidi override", async () => {
		for (const id of ["evil\u001b]0;pwned\u0007", "gpt\u202e4o", "model\u009b2J", "two\nlines", "zero\u200bwidth"]) {
			const fetch = vi.fn(async () => Response.json({ data: [{ id: "clean" }, { id }] }));
			const result = await discoverProviderModels(configured(), "deepseek", { fetch });
			expect(result).toMatchObject({ status: "error", note: "Vendor model list contains an invalid model ID" });
			expect(JSON.stringify(result)).not.toContain(id);
		}
	});

	it("keeps vendor ID punctuation and strips control sequences from display names", async () => {
		const ids = [
			"openai/gpt-4o:free",
			"anthropic.claude-3-5-sonnet-20240620-v1:0",
			"claude-3-5-sonnet@20240620",
			"accounts/fireworks/models/llama-v3p1-70b-instruct",
			"qwen2.5-coder:7b-instruct-q4_K_M",
			"Meta Llama 3 70B",
		];
		const fetch = vi.fn(async () =>
			Response.json({
				data: [
					...ids.map((id) => ({ id })),
					{ id: "linked", display_name: "\u001b]8;;https://attacker.example\u0007Click\u001b]8;;\u0007 me\u001b[31m" },
					{ id: "reordered", name: "\u202eevil\n\tname\u001b]0;title" },
					{ id: "blank", name: "\u001b[2J\u200b" },
				],
			}),
		);
		const rows = await requestVendorModels(configured().getProvider("deepseek")!, { apiKey: "key" }, { fetch });
		expect(rows).toEqual([
			...ids.map((id) => ({ id })),
			{ id: "linked", name: "Click me" },
			{ id: "reordered", name: "evil name" },
			{ id: "blank" },
		]);
	});

	it("checks an OpenAI credential against the ChatGPT list only when it resolved from OAuth", async () => {
		const fetch = vi.fn(async () =>
			Response.json({ models: [{ slug: "chatgpt-row", visibility: "list" }], data: [{ id: "api-row" }] }),
		);
		const provider = configured().getProvider("openai")!;
		const ids = async (credentialSource?: string) => {
			const check = await checkCredentialByList(provider, { apiKey: "token" }, { fetch, credentialSource });
			return check?.ok ? check.models.map((model) => model.id) : check;
		};
		expect(await ids("OAuth")).toEqual(["chatgpt-row"]);
		expect(await ids("OPENAI_API_KEY")).toEqual(["api-row"]);
		expect(await ids()).toEqual(["api-row"]);
	});
});
