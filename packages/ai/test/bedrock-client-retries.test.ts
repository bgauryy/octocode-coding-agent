import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext } from "./bedrock-fixtures.ts";

async function attempts(maxRetries?: number) {
	let count = 0;
	const output = await stream(bedrockModel, bedrockContext, {
		apiKey: "test",
		env: {},
		maxRetries,
		fetch: async () => {
			count++;
			return new Response(JSON.stringify({ message: "slow down" }), {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "0" },
			});
		},
	}).result();
	expect(output.stopReason).toBe("error");
	return count;
}

describe("Bedrock SDK retries", () => {
	it("makes one attempt by default so the session retry is the only retry layer", async () => {
		expect(await attempts()).toBe(1);
	});
	it("allows exactly maxRetries extra attempts when configured", async () => {
		expect(await attempts(2)).toBe(3);
		expect(await attempts(-4)).toBe(1);
	});
});
