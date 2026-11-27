import { describe, expect, it } from "vitest";
import { normalizeContext, streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

async function temperatureSent(headers?: Record<string, string>, modelHeaders?: Record<string, string>) {
	const base = getBuiltinModel("anthropic", "claude-sonnet-4-6");
	const model: Model<"anthropic-messages"> = { ...base, baseUrl: "http://127.0.0.1:9", headers: modelHeaders };
	let captured: { temperature?: number } | undefined;
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{
			apiKey: "k",
			temperature: 0.5,
			headers,
			onPayload: (payload) => {
				captured = payload as { temperature?: number };
				throw new Error("payload captured");
			},
		},
	).result();
	return captured?.temperature;
}

async function wireRequest(headers?: Record<string, string | null>) {
	const base = getBuiltinModel("anthropic", "claude-sonnet-4-6");
	const model: Model<"anthropic-messages"> = { ...base, baseUrl: "http://127.0.0.1:9" };
	let sent: { version: string | null; temperature?: number } | undefined;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { temperature?: number };
		sent = { version: new Headers(init?.headers).get("anthropic-version"), temperature: body.temperature };
		throw new Error("request captured");
	};
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{
			apiKey: "k",
			temperature: 0.5,
			headers,
			fetch,
			maxRetries: 0,
		},
	).result();
	return sent;
}

describe("Anthropic version actually sent", () => {
	it("pins the default version explicitly and keeps temperature when no header is configured", async () => {
		expect(await wireRequest()).toEqual({ version: "2023-06-01", temperature: 0.5 });
	});

	it("sends an old configured version unchanged with temperature", async () => {
		expect(await wireRequest({ "anthropic-version": "2026-10-20" })).toEqual({
			version: "2026-10-20",
			temperature: 0.5,
		});
	});

	it("sends a new configured version unchanged without temperature", async () => {
		expect(await wireRequest({ "anthropic-version": "2026-10-21" })).toEqual({ version: "2026-10-21" });
	});
});

describe("Anthropic sampling parameters by configured API version", () => {
	it("sends temperature with no version, the default version or an older one", async () => {
		expect(await temperatureSent()).toBe(0.5);
		expect(await temperatureSent({ "anthropic-version": "2023-06-01" })).toBe(0.5);
		expect(await temperatureSent({ "anthropic-version": "2026-10-20" })).toBe(0.5);
	});

	it("omits temperature from version 2026-10-21, however the header is cased or configured", async () => {
		expect(await temperatureSent({ "anthropic-version": "2026-10-21" })).toBeUndefined();
		expect(await temperatureSent({ "Anthropic-Version": "2027-01-01" })).toBeUndefined();
		expect(await temperatureSent(undefined, { "anthropic-version": "2026-10-21" })).toBeUndefined();
	});
});

describe("Anthropic client headers", () => {
	it("sets anthropic-version on the outgoing request", async () => {
		const { stream } = await import("../src/api/anthropic-messages.ts");
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-6");
		let version: string | null = null;
		await stream(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
			apiKey: "k",
			fetch: async (_input, init) => {
				version = new Headers(init?.headers).get("anthropic-version");
				return new Response(null, { status: 400 });
			},
		}).result();
		expect(version).toBe("2023-06-01");
	});
});
