import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";
describe("Bedrock custom headers", () => {
	it.each([stream, streamSimple])("forwards allowed headers and protects auth", async (run) => {
		let headers = new Headers();
		const result = await run(bedrockModel, bedrockContext, {
			apiKey: "fixture-token",
			headers: { "x-custom": "v", Authorization: "evil", "X-Amz-Date": "evil", HOST: "evil" },
			fetch: async (_input, init) => {
				headers = new Headers(init?.headers);
				return bedrockResponse(bedrockTextEvents);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(headers.get("x-custom")).toBe("v");
		expect(headers.get("authorization")).toBe("Bearer fixture-token");
		expect(headers.has("x-amz-date")).toBe(false);
		expect(headers.has("host")).toBe(false);
		expect([...headers.values()].join(" ")).not.toContain("octocode-sign-at-network-boundary");
	});
	it.each([undefined, {}])("works without custom headers %s", async (headers) => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			headers,
			fetch: async () => bedrockResponse(bedrockTextEvents),
		}).result();
		expect(result.stopReason).toBe("stop");
	});
});
