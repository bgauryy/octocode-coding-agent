import { AwsV4Signer } from "aws4fetch";
import { bedrockProviderModule } from "../src/bedrock-provider.ts";
import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";
const credentials = { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret", sessionToken: "fixture-session" };
describe("Bedrock final request signing", () => {
	it("signs the post-onPayload body and never sends the SDK placeholder", async () => {
		let checked = false;
		const result = await bedrockProviderModule
			.stream(bedrockModel, bedrockContext, {
				credentialProvider: async () => credentials,
				onPayload: (payload) => ({ ...(payload as object), requestMetadata: { test: "mutated" } }),
				fetch: async (input, init) => {
					const headers = new Headers(init?.headers);
					const auth = headers.get("authorization");
					expect(init?.body).toContain('"test":"mutated"');
					expect(auth).toContain("AWS4-HMAC-SHA256");
					expect([...headers.values()].join(" ")).not.toContain("octocode-sign-at-network-boundary");
					const signingHeaders = new Headers(headers);
					signingHeaders.delete("authorization");
					signingHeaders.delete("x-amz-date");
					signingHeaders.delete("x-amz-security-token");
					const expected = await new AwsV4Signer({
						url: input.toString(),
						method: "POST",
						body: init?.body as string,
						headers: signingHeaders,
						region: "us-east-1",
						service: "bedrock",
						datetime: headers.get("x-amz-date")!,
						...credentials,
					}).sign();
					expect(auth).toBe(expected.headers.get("authorization"));
					const unmodified = await new AwsV4Signer({
						url: input.toString(),
						method: "POST",
						body: "{}",
						headers: signingHeaders,
						region: "us-east-1",
						service: "bedrock",
						datetime: headers.get("x-amz-date")!,
						...credentials,
					}).sign();
					expect(auth).not.toBe(unmodified.headers.get("authorization"));
					checked = true;
					return bedrockResponse(bedrockTextEvents);
				},
			})
			.result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(checked).toBe(true);
	});
	it("resolves and signs credentials again on each retry", async () => {
		let attempt = 0;
		const provider = vi.fn(async () => ({ ...credentials, accessKeyId: `key-${++attempt}` }));
		const auth: string[] = [];
		const result = await stream(bedrockModel, bedrockContext, {
			credentialProvider: provider,
			maxRetries: 1,
			fetch: async (_input, init) => {
				auth.push(new Headers(init?.headers).get("authorization")!);
				return auth.length === 1
					? new Response('{"message":"retry"}', { status: 503, headers: { "retry-after": "0" } })
					: bedrockResponse(bedrockTextEvents);
			},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(provider).toHaveBeenCalledTimes(2);
		expect(auth[0]).toContain("Credential=key-1/");
		expect(auth[1]).toContain("Credential=key-2/");
	});
	it("does not leak auth in response errors", async () => {
		const result = await stream(bedrockModel, bedrockContext, {
			credentialProvider: async () => credentials,
			fetch: async () => new Response('{"message":"not authorized"}', { status: 403 }),
		}).result();
		const text = JSON.stringify(result);
		for (const value of [...Object.values(credentials), "octocode-sign-at-network-boundary"])
			expect(text).not.toContain(value);
	});
});
