import { describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

interface CachePayload {
	system?: Array<{ cachePoint?: { ttl?: string } }>;
	messages: Array<{ content: Array<{ cachePoint?: { ttl?: string } }> }>;
}

class PayloadCaptured extends Error {}

async function cachePoints(
	model: Model<"bedrock-converse-stream">,
	options: { cacheRetention?: "long"; env?: Record<string, string> } = { cacheRetention: "long" },
): Promise<Array<{ ttl?: string }>> {
	let payload: CachePayload | undefined;
	const context = normalizeContext({
		systemPrompt: "Be brief.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	});
	const s = streamBedrock(model, context, {
		...options,
		onPayload: (value) => {
			payload = value as CachePayload;
			throw new PayloadCaptured();
		},
	});
	for await (const event of s) if (event.type === "error") break;
	if (!payload) throw new Error("Expected Bedrock payload to be captured");
	return [...(payload.system ?? []), ...payload.messages.flatMap((message) => message.content)].flatMap((block) =>
		block.cachePoint ? [block.cachePoint] : [],
	);
}

describe("Bedrock long cache retention", () => {
	const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

	it("sends one-hour cache points by default", async () => {
		const points = await cachePoints(model);
		expect(points).toHaveLength(2);
		for (const point of points) expect(point.ttl).toBeDefined();
	});

	it("adds no cache points when OCTOCODE_CACHE_RETENTION is none", async () => {
		expect(await cachePoints(model, { env: { OCTOCODE_CACHE_RETENTION: "none" } })).toEqual([]);
	});

	it("keeps default cache points when the model does not support long retention", async () => {
		const points = await cachePoints({ ...model, compat: { ...model.compat, supportsLongCacheRetention: false } });
		expect(points).toHaveLength(2);
		for (const point of points) expect(point.ttl).toBeUndefined();
	});
});
