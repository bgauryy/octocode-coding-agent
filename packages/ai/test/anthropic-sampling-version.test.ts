import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
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
