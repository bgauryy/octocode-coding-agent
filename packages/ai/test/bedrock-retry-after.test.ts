import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext } from "./bedrock-fixtures.ts";
describe("Bedrock retry-after", () => {
	it.each(["9", undefined])("preserves retry hint %s", async (hint) => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			fetch: async () =>
				new Response('{"message":"Too many requests"}', { status: 429, headers: hint ? { "retry-after": hint } : {} }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBe(hint ? 9000 : undefined);
	});
});
