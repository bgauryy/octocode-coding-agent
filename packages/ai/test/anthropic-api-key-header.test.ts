import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

async function wireHeaders(apiKey: string, headers?: Record<string, string | null>) {
	const base = getBuiltinModel("anthropic", "claude-sonnet-4-6");
	const model: Model<"anthropic-messages"> = { ...base, baseUrl: "http://127.0.0.1:9" };
	let sent: Headers | undefined;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		sent = new Headers(init?.headers);
		throw new Error("request captured");
	};
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey, headers, fetch, maxRetries: 0 },
	).result();
	return sent;
}

describe("Anthropic API key header", () => {
	it("sends the key as x-api-key and no Authorization header", async () => {
		const sent = await wireHeaders("sk-test");
		expect(sent?.get("x-api-key")).toBe("sk-test");
		expect(sent?.get("authorization")).toBeNull();
	});

	it("lets a configured header replace the key header", async () => {
		const sent = await wireHeaders("sk-test", { "x-api-key": "other" });
		expect(sent?.get("x-api-key")).toBe("other");
		expect(sent?.get("authorization")).toBeNull();
	});

	it("lets a configured Authorization header through next to the key", async () => {
		const sent = await wireHeaders("sk-test", { authorization: "Bearer gateway" });
		expect(sent?.get("x-api-key")).toBe("sk-test");
		expect(sent?.get("authorization")).toBe("Bearer gateway");
	});
});
